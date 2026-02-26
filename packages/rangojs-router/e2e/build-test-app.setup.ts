import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { x } from "tinyexec";

// Builds the test-app for production tests.
// On cold starts the webServer command already built it, so we skip.
// On warm starts (reuseExistingServer) no build has run yet, so we build here.
test("build test-app", async () => {
  const cwd = path.resolve("./e2e/test-app");

  // Check for a recent build. The webServer command runs `pnpm build` before
  // starting the dev server on cold starts. Rebuilding here would overwrite
  // node_modules/.vite/deps, corrupting the running dev server's optimizer cache.
  const markerPath = path.join(cwd, "dist", "ssr", "index.js");
  if (fs.existsSync(markerPath)) {
    const ageMs = Date.now() - fs.statSync(markerPath).mtimeMs;
    if (ageMs < 5 * 60 * 1000) {
      return;
    }
  }

  await x("pnpm", ["build"], { nodeOptions: { cwd } });
});
