// Assemble .vercel/output (Build Output API v3) from the Vite dist/ build.
//
// Layout produced:
//   .vercel/output/
//     config.json                         routing: static first, else the function
//     static/                             dist/client (browser assets, served by CDN at /)
//     functions/index.func/
//       .vc-config.json                   Node serverless, streaming
//       index.mjs                         bundled launcher (srvx + @vercel/functions)
//       rsc/                              dist/rsc (self-contained RSC server bundle)
//       ssr/                              dist/ssr (rsc imports ../ssr/index.js at runtime)
//
// A prebuilt .vercel/output gets no `npm install`, so everything the function
// imports must physically live inside the .func directory. dist/rsc/index.js is
// already fully self-contained (no bare node_modules imports; all relative), and
// the launcher bundles its own deps, so no node_modules copying is needed.
import { rm, mkdir, cp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const dist = path.join(appRoot, "dist");
const out = path.join(appRoot, ".vercel", "output");
const funcDir = path.join(out, "functions", "index.func");

for (const dir of ["client", "rsc", "ssr"]) {
  if (!existsSync(path.join(dist, dir))) {
    throw new Error(
      `Missing dist/${dir}; run \`vite build\` before this script.`,
    );
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(funcDir, { recursive: true });

// 1. Static client assets -> served from the CDN at the root.
await cp(path.join(dist, "client"), path.join(out, "static"), {
  recursive: true,
});

// 2. Server bundle into the function. Preserve the rsc -> ../ssr/index.js
//    relative import by mirroring the dist/{rsc,ssr} layout inside the func.
await cp(path.join(dist, "rsc"), path.join(funcDir, "rsc"), {
  recursive: true,
});
await cp(path.join(dist, "ssr"), path.join(funcDir, "ssr"), {
  recursive: true,
});

// Prerender/static payload manifests (only present when routes are prerendered).
if (existsSync(path.join(dist, "static"))) {
  await cp(path.join(dist, "static"), path.join(funcDir, "static"), {
    recursive: true,
  });
}

// 3. Bundle the Node launcher. Inline srvx + @vercel/functions; keep the RSC
//    server bundle as a runtime-relative external so it resolves inside the func.
await build({
  entryPoints: [path.join(appRoot, "scripts", "func-entry.mjs")],
  outfile: path.join(funcDir, "index.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  plugins: [
    {
      name: "external-rsc-entry",
      setup(b) {
        b.onResolve({ filter: /^\.\/rsc\/index\.js$/ }, () => ({
          path: "./rsc/index.js",
          external: true,
        }));
      },
    },
  ],
});

// 4. Function config: Node serverless with response streaming (the proven shape
//    used by Nitro's vercel preset). shouldAddHelpers must stay false so srvx
//    reads the raw req/res for streaming.
await writeFile(
  path.join(funcDir, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 30,
    },
    null,
    2,
  ) + "\n",
);

// 5. Routing: filesystem (static/) first; everything else to the function.
await writeFile(
  path.join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/index" }],
    },
    null,
    2,
  ) + "\n",
);

console.log("Assembled .vercel/output (function: index.func)");
