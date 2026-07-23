import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { x } from "tinyexec";

function collectJsFiles(dir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) found.push(full);
    }
  }
  return found;
}

/**
 * Dev-build artifacts of React (e.g.
 * `react-dom-server.edge.development-<hash>.js`). These should never appear in
 * a production SSR/RSC bundle — their presence means `process.env.NODE_ENV`
 * wasn't folded to "production" at build time, so the CJS files re-export both
 * prod and dev variants.
 */
function findDevReactArtifacts(dir: string): string[] {
  return collectJsFiles(dir).filter((f) =>
    /react[-.][\w-]*\.development[\w.-]*\.js$/.test(path.basename(f)),
  );
}

interface JsFile {
  file: string;
  base: string;
  src: string;
}

/** Read every .js file under `dir` once; all guards filter over this list. */
function readJsFiles(dir: string): JsFile[] {
  return collectJsFiles(dir).map((file) => ({
    file,
    base: path.basename(file),
    src: fs.readFileSync(file, "utf-8"),
  }));
}

/**
 * Files that statically import `base` (`import …"…<base>"` /
 * `export … from "…<base>"`; `import.meta` and dynamic `import(` excluded).
 * Matches the forbidden shape directly so bundler formatting changes
 * false-negative instead of false-failing CI.
 */
function staticImportRefs(files: JsFile[], base: string): string[] {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\b(?:import|export)(?!\\s*[.(])[^;"'()]*?["'][^"']*${escaped}["']`,
  );
  return files
    .filter((f) => f.base !== base && f.src.includes(base) && re.test(f.src))
    .map((f) => f.file);
}

/**
 * Chunks carrying serialized route data. The per-router codegen
 * (generatePerRouterModule) emits the trie/precomputedEntries as
 * `JSON.parse("<literal>")`; string literals survive minification, and the
 * route trie is the only multi-KB one in the bundle (measured 40KB for
 * test-app's trie vs 1.7KB for the next-largest, the prerender manifest), so
 * literal size is a stable detector. If test-app ever shrinks below the
 * threshold this fails loudly (0 chunks found) rather than passing silently.
 */
function findRouteDataChunks(files: JsFile[]): string[] {
  const literalRe = /JSON\.parse\((["'])((?:\\.|(?!\1).)*)\1\)/g;
  const minLiteral = 8 * 1024;
  return files
    .filter((f) => {
      for (const m of f.src.matchAll(literalRe)) {
        if (m[2]!.length >= minLiteral) return true;
      }
      return false;
    })
    .map((f) => f.file);
}

// Builds the test-app for production tests.
// On cold starts the webServer command already built it, so we skip.
// On warm starts (reuseExistingServer) no build has run yet, so we build here.
test("build test-app", async () => {
  const cwd = path.resolve("./e2e/test-app");
  const genFilePath = path.join(cwd, "src", "router.named-routes.gen.ts");

  const hasStalePublicRouteTypes = () => {
    try {
      const content = fs.readFileSync(genFilePath, "utf-8");
      return (
        content.includes('"$prefix_') ||
        content.includes("/__dev/info") ||
        content.includes("/__dev/debug/routes")
      );
    } catch {
      return true;
    }
  };

  // Check for a recent build. The webServer command runs `pnpm build` before
  // starting the dev server on cold starts. Rebuilding here would overwrite
  // node_modules/.vite/deps, corrupting the running dev server's optimizer cache.
  const markerPath = path.join(cwd, "dist", "ssr", "index.js");
  const recentBuild =
    fs.existsSync(markerPath) &&
    Date.now() - fs.statSync(markerPath).mtimeMs < 5 * 60 * 1000 &&
    !hasStalePublicRouteTypes();

  if (!recentBuild) {
    await x("pnpm", ["build"], { nodeOptions: { cwd } });
  }

  // Bundle guard: production SSR/RSC must not ship React .development.js
  // chunks. If process.env.NODE_ENV isn't folded at build time, React's CJS
  // entry points pull in both prod and dev variants, doubling the bundle.
  const devArtifacts = findDevReactArtifacts(path.join(cwd, "dist"));
  expect(
    devArtifacts,
    `Production build must not emit React .development.js chunks. Found:\n${devArtifacts
      .map((f) => `  ${path.relative(cwd, f)}`)
      .join("\n")}`,
  ).toEqual([]);

  // Prefetch machinery must live in the eager router chunk, NOT a separate
  // lazy chunk. The request header is a stable marker owned by
  // browser/prefetch/fetch.ts. #766 split the prefetch runtime into its own
  // chunk to trim eager bytes, but production's `defaultPrefetch: "viewport"`
  // loads it on almost every page, so the split became a document -> router ->
  // runtime request waterfall (measured 502 ms critical path; see the
  // getManualChunks JSDoc). Same-chunk placement keeps loader.ts's dynamic
  // import fetch-free.
  const clientDir = path.join(cwd, "dist", "client");
  const clientFiles = readJsFiles(clientDir);
  const prefetchChunks = clientFiles.filter((f) =>
    f.src.includes("X-Rango-Prefetch"),
  );
  expect(
    prefetchChunks.map((f) => path.relative(cwd, f.file)),
    "Prefetch machinery must land in exactly one client chunk",
  ).toHaveLength(1);
  expect(
    prefetchChunks[0]!.base.startsWith("router-"),
    `Prefetch machinery must live in the eager router chunk, found ${prefetchChunks[0]!.base}`,
  ).toBe(true);

  // Bundle guard (Bundle Hygiene rule #1): serialized route data (trie +
  // precomputedEntries) lives in exactly ONE chunk, RSC-only, reachable only
  // via dynamic import(). Test-app is single-router, so exactly one data
  // chunk; a second copy means the eager manifest is inlining route data
  // again (regression mode of commit d10a2470).
  const rscDir = path.join(cwd, "dist", "rsc");
  const rscFiles = readJsFiles(rscDir);
  const rscDataChunks = findRouteDataChunks(rscFiles);
  expect(
    rscDataChunks.map((f) => path.relative(cwd, f)),
    "Serialized route data must land in exactly one RSC chunk",
  ).toHaveLength(1);
  for (const env of ["client", "ssr"]) {
    const leaked = findRouteDataChunks(
      readJsFiles(path.join(cwd, "dist", env)),
    );
    expect(
      leaked.map((f) => path.relative(cwd, f)),
      `Serialized route data must not ship in the ${env} bundle`,
    ).toEqual([]);
  }

  // Lazy-only: no chunk may import the data chunk statically — that would
  // pull the trie onto the eager startup path (issue #665's cold-start cost)
  // without changing chunk count.
  const dataChunk = rscDataChunks[0]!;
  const dataBase = path.basename(dataChunk);
  expect(
    staticImportRefs(rscFiles, dataBase).map((f) => path.relative(cwd, f)),
    `The route-data chunk ${dataBase} must be referenced only via dynamic import()`,
  ).toEqual([]);
  const referencingChunks = rscFiles.filter(
    (f) => f.file !== dataChunk && f.src.includes(dataBase),
  );
  expect(
    referencingChunks.length,
    `The route-data chunk ${dataBase} must be wired via ensureRouterManifest's dynamic import`,
  ).toBeGreaterThan(0);

  // Prerender/shell/static artifact discipline (prerender-api-design.md: the
  // worker serves everything; payloads are lazy read-through). __pr-* (baked
  // Flight), __ps-* (PPR shells), and __st-* (static handler payloads) are
  // RSC-only data chunks reached through manifest thunk tables — never
  // statically imported, never shipped to client/ssr. Their manifests
  // (__prerender-manifest.js, __shell-manifest.js) load via globalThis
  // thunks and must stay dynamic too.
  const payloadRe = /^__(pr|ps|st)-/;
  const rscPayloads = rscFiles
    .map((f) => f.base)
    .filter((b) => payloadRe.test(b));
  expect(
    rscPayloads.length,
    "test-app must bake prerender/shell/static payload chunks — 0 means the guard lost its subject",
  ).toBeGreaterThan(0);
  for (const env of ["client", "ssr"]) {
    const leaked = collectJsFiles(path.join(cwd, "dist", env))
      .map((f) => path.basename(f))
      .filter((b) => payloadRe.test(b));
    expect(
      leaked,
      `Prerender/shell/static payloads must not ship in the ${env} bundle`,
    ).toEqual([]);
  }
  const payloadStaticRefs: string[] = [];
  for (const base of [
    ...rscPayloads,
    "__prerender-manifest.js",
    "__shell-manifest.js",
    "__static-manifest.js",
  ]) {
    for (const f of staticImportRefs(rscFiles, base)) {
      payloadStaticRefs.push(`${path.relative(cwd, f)} -> ${base}`);
    }
  }
  expect(
    payloadStaticRefs,
    "Payload chunks and their manifests must be referenced only via dynamic import()",
  ).toEqual([]);

  // __static-manifest.js loads lazily behind the __loadStaticManifestModule
  // thunk (issue #760: the table grows O(#Static handlers) and must stay off
  // the worker's eager cold-start path; static-store.ts resolves the thunk on
  // the first Static() lookup). It must stay a thunk-only lookup table; a
  // payload marker or multi-KB body means page data landed in the manifest.
  const staticManifest = path.join(rscDir, "__static-manifest.js");
  expect(
    fs.existsSync(staticManifest),
    "test-app has Static() handlers, so the build must emit __static-manifest.js",
  ).toBe(true);
  const staticManifestSrc = fs.readFileSync(staticManifest, "utf-8");
  expect(
    staticManifestSrc,
    "__static-manifest.js must carry import thunks only, no payloads",
  ).not.toMatch(/"segments"|"encoded"|"handles"/);
  expect(staticManifestSrc.length).toBeLessThan(32 * 1024);
  const rscEntry = fs.readFileSync(path.join(rscDir, "index.js"), "utf-8");
  expect(
    rscEntry,
    "the RSC entry must wire the lazy static-manifest loader thunk",
  ).toContain(
    '__loadStaticManifestModule = () => import("./__static-manifest.js")',
  );
});
