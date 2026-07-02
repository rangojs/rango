/**
 * Vercel Build Output (Build Output API v3) emitter for `preset: "vercel"`.
 *
 * After the full app build, restructures dist/ into .vercel/output:
 *
 *   .vercel/output/
 *     config.json                       routing: static first, else the function
 *     static/                           dist/client (browser assets, served at /)
 *     functions/<name>.func/
 *       .vc-config.json                 Node serverless, response streaming
 *       index.mjs                       bundled launcher (srvx + @vercel/functions)
 *       rsc/                            dist/rsc (self-contained RSC server bundle)
 *       ssr/                            dist/ssr (rsc imports ../ssr/index.js)
 *
 * A prebuilt .vercel/output gets no `npm install`, so everything the function
 * imports must physically live inside the .func directory. This relies on two
 * things the vercel preset arranges (each is a failure only a real deploy — or
 * the isolated smoke test — catches, since a local in-place run is masked by the
 * app's own package.json + node_modules up the tree):
 *
 *   1. The rsc/ssr builds are fully bundled (`resolve.noExternal`, set in
 *      rango.ts for this preset). The node default externalizes node_modules
 *      deps, which works under `vite preview` but leaves bare imports
 *      (@vercel/functions, react-dom/server.edge, ...) that have no node_modules
 *      to resolve against on Vercel.
 *   2. A `package.json` with `"type": "module"` is written into the .func dir.
 *      The rsc/ssr bundles are ESM but use a `.js` extension; without a
 *      type:module in scope the deployed (isolated) function loads them as
 *      CommonJS and fails on the first `import`.
 *
 * The launcher is bundled with srvx (the Web->Node streaming bridge, a
 * @rangojs/router dependency) and @vercel/functions (resolved from the app)
 * inlined, keeping the RSC bundle a runtime-relative external.
 *
 * Timing: this runs in the `buildApp` hook (order "post"), which fires once
 * after every environment has built, so dist/{client,rsc,ssr} all exist.
 * closeBundle is unusable here — it fires per environment, and twice for ssr
 * (the server-reference scan and the real build), so it would run before
 * dist/client exists. rango's own prerender/static emitters hardcode dist/rsc,
 * so we build to dist/ and restructure here rather than retargeting outDir.
 */

import type { Plugin } from "vite";
import { rm, mkdir, cp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { escapeRegExp } from "../../regex-escape.js";
import type {
  RangoVercelOptions,
  VercelPresetOptions,
} from "../plugin-types.js";

// Minimal structural types for the esbuild API we use, resolved dynamically from
// the app so @rangojs/router does not depend on esbuild's type package.
interface EsbuildPluginBuild {
  onResolve(
    options: { filter: RegExp },
    callback: () => { path: string; external: boolean },
  ): void;
}
type EsbuildBuild = (options: Record<string, unknown>) => Promise<unknown>;
interface EsbuildModule {
  build?: EsbuildBuild;
  default?: { build?: EsbuildBuild };
}

const LAUNCHER_SOURCE = `import { toNodeHandler } from "srvx/node";
import { waitUntil } from "@vercel/functions";
import rscHandler from "./rsc/index.js";

// The Vercel Node launcher invokes a Node (req, res) handler, not a Web fetch
// handler. srvx's toNodeHandler bridges the Rango Web fetch handler and pipes
// the streamed Response to the Node response (set supportsResponseStreaming).
const onVercel = Boolean(process.env.VERCEL);

const fetchHandler = (request) =>
  rscHandler(request, {
    env: process.env,
    // Forward Vercel's waitUntil so cache writes / revalidation run off the
    // response path. Omitted off-platform so those writes settle inline.
    ctx: onVercel ? { waitUntil } : undefined,
  });

export default toNodeHandler(fetchHandler);
`;

/**
 * Reject a non-Node runtime for the vercel preset. The preset only emits a Node
 * serverless function (launcherType "Nodejs", bundled Node APIs, response
 * streaming). Vercel's Edge runtime needs a different Build Output primitive
 * (EdgeFunction, a Web-handler entry, no node_modules) that this assembler does
 * not produce, so a non-nodejs runtime would emit a config the platform rejects
 * or mis-runs. Fail fast at build time instead of shipping a broken function.
 */
export function assertVercelNodeRuntime(runtime: string | undefined): void {
  if (runtime != null && !runtime.startsWith("nodejs")) {
    throw new Error(
      `[rango] preset "vercel": runtime "${runtime}" is not supported. ` +
        `This preset emits a Node serverless function; use a "nodejs*" runtime ` +
        `(default "nodejs22.x"). The Edge runtime is not supported.`,
    );
  }
}

/**
 * The function name becomes a `.func` directory segment and the config.json
 * route `dest` (`/${functionName}`). An empty or space/slash-containing value
 * would land raw in both, producing a broken function path, so restrict it to a
 * safe single path segment and fail loudly rather than emit unroutable output.
 */
export function assertValidVercelFunctionName(functionName: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(functionName)) {
    throw new Error(
      `[rango] preset "vercel": invalid functionName ${JSON.stringify(
        functionName,
      )}. Use letters, digits, ".", "_" or "-" only (it becomes the .func directory and the routing dest).`,
    );
  }
}

/** The `.vc-config.json` body: a Node serverless function with streaming. */
export function buildVercelVcConfig(
  vercel: VercelPresetOptions,
): Record<string, unknown> {
  const vcConfig: Record<string, unknown> = {
    runtime: vercel.runtime ?? "nodejs22.x",
    handler: "index.mjs",
    launcherType: "Nodejs",
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    maxDuration: vercel.maxDuration ?? 30,
  };
  if (vercel.memory != null) vcConfig.memory = vercel.memory;
  if (vercel.regions != null) vcConfig.regions = vercel.regions;
  return vcConfig;
}

/**
 * The Build Output API v3 `config.json` body. Routes, in order: long-cache the
 * content-hashed assets under `${assetsDir}/` (safe to serve `immutable`;
 * without this Vercel serves them `max-age=0, must-revalidate` and browsers
 * re-request every asset on each visit), then the filesystem handler, then
 * everything to the function. The header route uses `continue: true` so it falls
 * through to the filesystem handler that actually serves the file.
 *
 * Route `src` values are REGEXES on Vercel, so the prefix is regex-escaped
 * (an unescaped `assetsDir: "static.v2"` would immutable-stamp any
 * `/static?v2/...` path, including function-rendered pages). An empty
 * assetsDir (assets at the outDir root) gets no header route at all: there is
 * no prefix separating hashed from non-hashed files, so fall back to Vercel's
 * safe default headers. Two accepted edges, matching what other framework
 * adapters (Astro, SvelteKit) emit: files a user places in
 * `public/${assetsDir}/` land under the same prefix and are also stamped
 * immutable (assemble() warns about the collision), and a request for a
 * MISSING asset falls through to the function whose 404 carries the header.
 */
export function buildVercelOutputConfig(
  functionName: string,
  assetsDir: string,
): { version: number; routes: unknown[] } {
  const assetsPrefix = assetsDir.replace(/^\/+|\/+$/g, "");
  const assetHeaderRoute = assetsPrefix
    ? [
        {
          src: `/${escapeRegExp(assetsPrefix)}/(.*)`,
          headers: { "cache-control": "public, max-age=31536000, immutable" },
          continue: true,
        },
      ]
    : [];
  return {
    version: 3,
    routes: [
      ...assetHeaderRoute,
      { handle: "filesystem" },
      { src: "/(.*)", dest: `/${functionName}` },
    ],
  };
}

async function assemble(
  root: string,
  options: RangoVercelOptions,
  assetsDir: string,
  publicDir: string,
): Promise<void> {
  const vercel = options.vercel ?? {};
  // Validate config before touching the build output.
  assertVercelNodeRuntime(vercel.runtime);

  // Files in public/<assetsDir>/ are copied into the same output prefix as the
  // content-hashed build assets, so the immutable cache-control route stamps
  // them too -- replacing such a file after a deploy never reaches returning
  // visitors. Warn instead of silently pinning.
  const assetsPrefix = assetsDir.replace(/^\/+|\/+$/g, "");
  if (publicDir && assetsPrefix && existsSync(join(publicDir, assetsPrefix))) {
    console.warn(
      `[rango] preset "vercel": ${join(publicDir, assetsPrefix)} exists. ` +
        `Files under public/${assetsPrefix}/ share the /${assetsPrefix}/ URL prefix ` +
        `with hashed build assets and will be served with a one-year immutable ` +
        `cache-control header. Move un-hashed public files out of "${assetsPrefix}/".`,
    );
  }

  const dist = join(root, "dist");
  for (const dir of ["client", "rsc", "ssr"]) {
    if (!existsSync(join(dist, dir))) {
      throw new Error(
        `[rango] preset "vercel": missing dist/${dir}. Run the production build first.`,
      );
    }
  }
  const functionName = vercel.functionName ?? "index";
  assertValidVercelFunctionName(functionName);
  const out = join(root, ".vercel", "output");
  const funcDir = join(out, "functions", `${functionName}.func`);

  await rm(out, { recursive: true, force: true });
  await mkdir(funcDir, { recursive: true });

  // 1. Static client assets -> served from the CDN at the root.
  await cp(join(dist, "client"), join(out, "static"), { recursive: true });

  // 2. Server bundle into the function. Preserve the rsc -> ../ssr/index.js
  //    relative import by mirroring the dist/{rsc,ssr} layout inside the func.
  await cp(join(dist, "rsc"), join(funcDir, "rsc"), { recursive: true });
  await cp(join(dist, "ssr"), join(funcDir, "ssr"), { recursive: true });

  // Prerender/static payload manifests (present only when routes are prerendered).
  if (existsSync(join(dist, "static"))) {
    await cp(join(dist, "static"), join(funcDir, "static"), {
      recursive: true,
    });
  }

  // 3. Bundle the Node launcher. srvx (a @rangojs/router dependency) is aliased
  //    to its resolved path; @vercel/functions resolves from the app; the RSC
  //    server bundle stays a runtime-relative external.
  const rangoRequire = createRequire(import.meta.url);
  let srvxNodePath: string;
  try {
    srvxNodePath = rangoRequire.resolve("srvx/node");
  } catch {
    throw new Error(
      '[rango] preset "vercel" requires "srvx" (a dependency of @rangojs/router). Reinstall dependencies.',
    );
  }

  // esbuild ships with Vite, so we never add it as a @rangojs/router dependency.
  // It is a DIRECT dependency of Vite but only a TRANSITIVE one from the app's
  // view, so under strict pnpm it is NOT resolvable from the app root. Resolve it
  // through Vite's module location (Vite is a direct app dependency, and esbuild
  // is a direct dependency of Vite). Minimal structural types avoid coupling to
  // esbuild's type package at compile time.
  const appRequire = createRequire(join(root, "package.json"));
  const resolveEsbuildPath = (): string => {
    try {
      const viteRequire = createRequire(appRequire.resolve("vite"));
      return viteRequire.resolve("esbuild");
    } catch {
      // Intentionally empty: fall through to the app/rango fallbacks below.
    }
    try {
      return appRequire.resolve("esbuild");
    } catch {
      // Intentionally empty: last resort is @rangojs/router's own resolver.
    }
    return rangoRequire.resolve("esbuild");
  };
  let esbuildModule: EsbuildModule;
  try {
    esbuildModule = (await import(
      pathToFileURL(resolveEsbuildPath()).href
    )) as EsbuildModule;
  } catch {
    throw new Error(
      '[rango] preset "vercel" requires "esbuild" to bundle the function launcher. It ships with Vite; reinstall dependencies (or add esbuild to your app dependencies).',
    );
  }
  const esbuildBuild = esbuildModule.build ?? esbuildModule.default?.build;
  if (typeof esbuildBuild !== "function") {
    throw new Error('[rango] preset "vercel": could not load esbuild.build.');
  }

  try {
    await esbuildBuild({
      stdin: {
        contents: LAUNCHER_SOURCE,
        resolveDir: root,
        sourcefile: "func-entry.mjs",
        loader: "js",
      },
      outfile: join(funcDir, "index.mjs"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node18",
      alias: { "srvx/node": srvxNodePath },
      plugins: [
        {
          name: "external-rsc-entry",
          setup(b: EsbuildPluginBuild) {
            b.onResolve({ filter: /^\.\/rsc\/index\.js$/ }, () => ({
              path: "./rsc/index.js",
              external: true,
            }));
          },
        },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/@vercel\/functions/.test(message)) {
      throw new Error(
        '[rango] preset "vercel": could not resolve "@vercel/functions". Add it to your app dependencies (it also backs VercelCacheStore).\n' +
          message,
      );
    }
    throw error;
  }

  // 3b. Mark the function as ESM. The rsc/ssr bundles are .js ESM files with no
  //     package.json in scope on the deployed function (it is isolated at
  //     /var/task), so Node would load them as CommonJS and fail on `import`.
  //     Locally this is masked because the func inherits the app's
  //     "type": "module" up the tree; the deployed func has nothing above it.
  await writeFile(
    join(funcDir, "package.json"),
    JSON.stringify({ type: "module" }, null, 2) + "\n",
  );

  // 4. Function config: Node serverless with response streaming.
  await writeFile(
    join(funcDir, ".vc-config.json"),
    JSON.stringify(buildVercelVcConfig(vercel), null, 2) + "\n",
  );

  // 5. Routing config (immutable assets -> filesystem -> function).
  await writeFile(
    join(out, "config.json"),
    JSON.stringify(buildVercelOutputConfig(functionName, assetsDir), null, 2) +
      "\n",
  );

  console.log(
    `[rango] assembled .vercel/output (function: ${functionName}.func)`,
  );
}

export function createVercelOutputPlugin(options: RangoVercelOptions): Plugin {
  let root = process.cwd();
  let isBuild = false;
  // The client build's assetsDir (Vite default "assets"); used to scope the
  // immutable cache-control route to the content-hashed asset output.
  let assetsDir = "assets";
  // Resolved publicDir ("" when disabled); used to warn when public/<assetsDir>
  // exists, since its un-hashed files share the immutable-header prefix.
  let publicDir = "";
  return {
    name: "@rangojs/router:vercel-output",
    configResolved(config) {
      root = resolve(config.root);
      isBuild = config.command === "build";
      assetsDir =
        config.environments?.client?.build?.assetsDir ??
        config.build?.assetsDir ??
        "assets";
      publicDir = config.publicDir || "";
    },
    // buildApp runs once after the whole multi-environment build (rsc, client,
    // ssr), so dist/ is complete here. closeBundle is unusable for this: it
    // fires per environment, and twice for ssr (the server-reference scan and
    // the real build), so it would run before dist/client exists.
    buildApp: {
      order: "post",
      async handler() {
        if (!isBuild) return;
        await assemble(root, options, assetsDir, publicDir);
      },
    },
  };
}
