import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { x } from "tinyexec";

/**
 * Walks `dir` recursively and returns paths of dev-build artifacts of React
 * (e.g. `react-dom-server.edge.development-<hash>.js`). These should never
 * appear in a production SSR/RSC bundle — their presence means
 * `process.env.NODE_ENV` wasn't folded to "production" at build time, so the
 * CJS files re-export both prod and dev variants.
 */
function findDevReactArtifacts(dir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (
        entry.isFile() &&
        /react[-.][\w-]*\.development[\w.-]*\.js$/.test(entry.name)
      ) {
        found.push(full);
      }
    }
  }
  return found;
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
});
