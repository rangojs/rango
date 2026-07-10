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

/**
 * Chunks carrying serialized route data. The per-router codegen
 * (generatePerRouterModule) emits the trie/precomputedEntries as
 * `JSON.parse("<literal>")`; string literals survive minification, and the
 * route trie is the only multi-KB one in the bundle (measured 40KB for
 * test-app's trie vs 1.7KB for the next-largest, the prerender manifest), so
 * literal size is a stable detector. If test-app ever shrinks below the
 * threshold this fails loudly (0 chunks found) rather than passing silently.
 */
function findRouteDataChunks(dir: string): string[] {
  const literalRe = /JSON\.parse\((["'])((?:\\.|(?!\1).)*)\1\)/g;
  const minLiteral = 8 * 1024;
  return collectJsFiles(dir).filter((file) => {
    const src = fs.readFileSync(file, "utf-8");
    for (const m of src.matchAll(literalRe)) {
      if (m[2]!.length >= minLiteral) return true;
    }
    return false;
  });
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

  // Bundle guard (Bundle Hygiene rule #1): serialized route data (trie +
  // precomputedEntries) lives in exactly ONE chunk, RSC-only, reachable only
  // via dynamic import(). Test-app is single-router, so exactly one data
  // chunk; a second copy means the eager manifest is inlining route data
  // again (regression mode of commit d10a2470).
  const rscDataChunks = findRouteDataChunks(path.join(cwd, "dist", "rsc"));
  expect(
    rscDataChunks.map((f) => path.relative(cwd, f)),
    "Serialized route data must land in exactly one RSC chunk",
  ).toHaveLength(1);
  for (const env of ["client", "ssr"]) {
    const leaked = findRouteDataChunks(path.join(cwd, "dist", env));
    expect(
      leaked.map((f) => path.relative(cwd, f)),
      `Serialized route data must not ship in the ${env} bundle`,
    ).toEqual([]);
  }

  // Lazy-only: no chunk may import the data chunk statically — that would
  // pull the trie onto the eager startup path (issue #665's cold-start cost)
  // without changing chunk count. The regex matches the forbidden
  // static-import shape directly (`import …"<base>"` / `export … "<base>"`,
  // first string after the keyword, `import.meta`/`import(` excluded) rather
  // than proving each reference sits inside `import(`, so bundler formatting
  // changes false-negative instead of false-failing CI.
  const dataChunk = rscDataChunks[0]!;
  const dataBase = path.basename(dataChunk);
  const escapedBase = dataBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const staticImportRe = new RegExp(
    `\\b(?:import|export)(?!\\s*[.(])[^;"'()]*?["'][^"']*${escapedBase}["']`,
  );
  const staticRefs: string[] = [];
  let referencingChunks = 0;
  for (const file of collectJsFiles(path.join(cwd, "dist", "rsc"))) {
    if (file === dataChunk) continue;
    const src = fs.readFileSync(file, "utf-8");
    if (!src.includes(dataBase)) continue;
    referencingChunks++;
    if (staticImportRe.test(src)) staticRefs.push(path.relative(cwd, file));
  }
  expect(
    staticRefs,
    `The route-data chunk ${dataBase} must be referenced only via dynamic import()`,
  ).toEqual([]);
  expect(
    referencingChunks,
    `The route-data chunk ${dataBase} must be wired via ensureRouterManifest's dynamic import`,
  ).toBeGreaterThan(0);
});
