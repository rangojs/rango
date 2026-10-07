/**
 * Builds the cache-versions fixture (__fixtures__/cache-versions) with the
 * real `vite build`, once per scenario, each in its own copy of the fixture.
 *
 * The plugin under test is bundled from THIS checkout's source into a private
 * directory first, so the builds never run a stale `dist/vite` (the published
 * entry the fixture would otherwise load through `@rangojs/router/vite`).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..", "..", "..");
const fixtureRoot = resolve(here, "..", "__fixtures__", "cache-versions");
const require = createRequire(import.meta.url);

/** Fixed key so builds differ only where a scenario makes them differ. */
export const FIXTURE_ENCRYPTION_KEY =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
export const OTHER_ENCRYPTION_KEY =
  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=";

export interface FixtureVersions {
  data: string;
  document: string;
  dataInputs: Record<string, string>;
  documentInputs: Record<string, string>;
}

export interface FixtureBuild {
  /** The copy of the fixture that was built. */
  root: string;
  /** Versions by the router's source file, e.g. "src/apps/a/router.tsx". */
  routers: Record<string, FixtureVersions>;
  /** The whole-build pair. */
  whole: FixtureVersions;
  /** The table as the built version module holds it. */
  table: Record<string, [string, string]>;
  /** Server files in no router's version, by identity. */
  unownedFiles: string[];
  output: string;
}

export interface FixtureScenario {
  /** Files to overwrite (path relative to the fixture root) before building. */
  edits?: Record<string, string | ((source: string) => string)>;
  /** `rango({ encryptionKey })`. Defaults to FIXTURE_ENCRYPTION_KEY. */
  encryptionKey?: string | null;
  /** Extra rango() options, as source text spread into the call. */
  rangoOptions?: string;
  /**
   * Run `vite build <root>` from the directory above the root, the way a
   * monorepo script does, instead of `vite build` in the root.
   */
  fromParentDirectory?: boolean;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    // The key comes from rango({ encryptionKey }) only; an inherited
    // RANGO_ENCRYPTION_KEY would stand in when a scenario passes none.
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "true" };
    delete env.RANGO_ENCRYPTION_KEY;
    // Vitest's NODE_ENV=test would reach the build's discovery server, which
    // then compiles JSX for the dev runtime against a production React.
    delete env.NODE_ENV;
    for (const name of Object.keys(env)) {
      if (name.startsWith("VITEST")) delete env[name];
    }
    Object.assign(env, extraEnv);
    const child = spawn(command, args, { cwd, env });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, output }));
  });
}

let pluginEntry: Promise<string> | undefined;

/**
 * Bundle src/vite/index.ts the way `pnpm build` does, into a directory under
 * the package's node_modules so the bundle's bare imports resolve.
 */
export function bundlePluginFromSource(): Promise<string> {
  pluginEntry ??= (async () => {
    const outDir = join(
      packageRoot,
      "node_modules",
      ".rango-cache-versions-test",
      "vite",
    );
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(join(outDir, "plugins"), { recursive: true });
    const outfile = join(outDir, "index.js");
    const esbuild = join(packageRoot, "node_modules", ".bin", "esbuild");
    const { code, output } = await run(
      esbuild,
      [
        "src/vite/index.ts",
        "--bundle",
        "--format=esm",
        `--outfile=${outfile}`,
        "--platform=node",
        "--packages=external",
        "--log-level=warning",
      ],
      packageRoot,
    );
    if (code !== 0) throw new Error(`esbuild failed:\n${output}`);
    cpSync(
      join(packageRoot, "src/vite/plugins/cloudflare-protocol-loader-hook.mjs"),
      join(outDir, "plugins/cloudflare-protocol-loader-hook.mjs"),
    );
    return outfile;
  })();
  return pluginEntry;
}

/** A directory to hold fixture copies, removed by the returned function. */
export function createFixtureWorkspace(): {
  dir: string;
  cleanup: () => void;
} {
  // realpath: os.tmpdir() is a symlink on macOS and Vite resolves it, so a
  // root under the link would not be a prefix of its own module ids.
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "rango-cache-versions-")),
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function linkDependency(root: string, name: string, target: string): void {
  const link = join(root, "node_modules", name);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, "dir");
}

/** Copy the fixture into `root`, apply the scenario and run `vite build`. */
export async function buildFixture(
  root: string,
  scenario: FixtureScenario = {},
): Promise<FixtureBuild> {
  const plugin = await bundlePluginFromSource();
  cpSync(fixtureRoot, root, { recursive: true });
  // vendor/ holds the fixture's installed dependencies: real packages under
  // node_modules, so the node preset externalizes them. A scenario edits them
  // there, the way a lockfile bump changes what is installed.
  renameSync(join(root, "vendor"), join(root, "node_modules"));
  for (const [file, edit] of Object.entries(scenario.edits ?? {})) {
    const path = join(root, file);
    let source = "";
    try {
      source = readFileSync(path, "utf-8");
    } catch {}
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof edit === "string" ? edit : edit(source));
  }

  linkDependency(root, "@rangojs/router", packageRoot);
  for (const name of ["react", "react-dom"]) {
    linkDependency(
      root,
      name,
      dirname(require.resolve(`${name}/package.json`)),
    );
  }

  const key =
    scenario.encryptionKey === undefined
      ? FIXTURE_ENCRYPTION_KEY
      : scenario.encryptionKey;
  writeFileSync(
    join(root, "vite.config.mjs"),
    [
      `import { rango } from ${JSON.stringify(plugin)};`,
      `export default {`,
      `  logLevel: "warn",`,
      `  define: { "process.env.NODE_ENV": JSON.stringify("production") },`,
      `  plugins: [rango({`,
      `    preset: "node",`,
      `    hostRouter: "./src/host.rsc.tsx",`,
      `    banner: false,`,
      key === null ? "" : `    encryptionKey: ${JSON.stringify(key)},`,
      scenario.rangoOptions ? `    ...${scenario.rangoOptions},` : "",
      `  })],`,
      `};`,
      "",
    ].join("\n"),
  );

  const vite = join(
    dirname(require.resolve("vite/package.json")),
    "bin/vite.js",
  );
  const { code, output } = scenario.fromParentDirectory
    ? await run(
        process.execPath,
        [vite, "build", basename(root)],
        dirname(root),
      )
    : await run(process.execPath, [vite, "build"], root);
  if (code !== 0) {
    throw new Error(`vite build failed in ${root} (exit ${code}):\n${output}`);
  }

  const report = JSON.parse(
    readFileSync(
      join(root, "node_modules/.rangojs-router-build/cache-versions.json"),
      "utf-8",
    ),
  ) as {
    routers: Record<string, FixtureVersions & { source: string }>;
    unownedFiles: string[];
  };
  const routers: Record<string, FixtureVersions> = {};
  const table: Record<string, [string, string]> = {};
  for (const [id, entry] of Object.entries(report.routers)) {
    table[id] = [entry.data, entry.document];
    if (id !== "*") routers[entry.source] = entry;
  }
  return {
    root,
    routers,
    whole: report.routers["*"]!,
    table,
    unownedFiles: report.unownedFiles,
    output,
  };
}

export interface FixtureResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

const RESPONSES_MARKER = "__FIXTURE_RESPONSES__";

const SERVE_SCRIPT = `
const { default: handler } = await import("./dist/rsc/index.js");
const out = [];
for (const url of process.argv.slice(2)) {
  const response = await handler(
    new Request(url, { headers: { accept: "text/html" } }),
    { env: {}, ctx: { waitUntil() {}, passThroughOnException() {} } },
  );
  out.push({
    url,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  });
}
process.stdout.write("\\n${RESPONSES_MARKER}" + JSON.stringify(out) + "\\n");
process.exit(0);
`;

/**
 * Document requests served by a built fixture's server entry, in order, in a
 * process of their own: the first one is the first request of a cold server.
 */
export async function requestBuiltFixture(
  root: string,
  urls: string[],
): Promise<FixtureResponse[]> {
  const script = join(root, "serve-requests.mjs");
  writeFileSync(script, SERVE_SCRIPT);
  const { code, output } = await run(
    process.execPath,
    [script, ...urls],
    root,
    { NODE_ENV: "production" },
  );
  const marker = output.lastIndexOf(RESPONSES_MARKER);
  if (code !== 0 || marker === -1) {
    throw new Error(`serving ${root} failed (exit ${code}):\n${output}`);
  }
  return JSON.parse(
    output.slice(marker + RESPONSES_MARKER.length).split("\n")[0]!,
  ) as FixtureResponse[];
}
