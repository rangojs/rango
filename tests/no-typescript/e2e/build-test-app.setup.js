import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { x } from "tinyexec";

// Matches the documented `react*.development*.js` glob (AGENTS.md Bundle
// Hygiene rule #2) against a chunk basename. The middle/trailing segments allow
// dots so it catches the multi-segment server artifacts a non-folded NODE_ENV
// emits — e.g. react-dom-server.edge.development-<hash>.js,
// react-dom-server.browser.development.js, and plain react.development.js — not
// just react-dom.development-<hash>.js.
const DEV_REACT_CHUNK = /^react[\w.-]*\.development[\w.-]*\.js$/;

// Size ceiling for the SSR/RSC entry bundles. The filename check above is
// necessary but NOT sufficient for this build topology: a non-folded NODE_ENV
// inlines React's dev branches straight into ssr/index.js and rsc/index.js
// rather than emitting a separate react*.development*.js chunk, so the filename
// walk would miss it. Measured: ssr/index.js ~642 kB folded vs ~1.47 MB
// non-folded (rsc similar). A 1 MB ceiling sits well between the two, so it
// reliably catches a regression of the vite.config.js fold (AGENTS.md rule #2)
// while leaving ample headroom for normal growth of this small app.
const ENTRY_BUNDLES = ["ssr/index.js", "rsc/index.js"];
const MAX_ENTRY_BYTES = 1_000_000;

/**
 * Walks `dir` recursively and returns paths of React dev-build artifacts (e.g.
 * `react-dom-server.edge.development-<hash>.js`). These must never appear in a
 * production SSR/RSC bundle: their presence means `process.env.NODE_ENV` was
 * not folded to "production" at build time, so React's CJS files re-export both
 * prod and dev variants, doubling the bundle. This is a vanilla `vite build`
 * app, so the fold relies entirely on the `define` in vite.config.js — see
 * AGENTS.md > Bundle Hygiene rule #2.
 */
function findDevReactArtifacts(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && DEV_REACT_CHUNK.test(entry.name)) {
        found.push(full);
      }
    }
  }
  return found;
}

// Build the app once so production-mode tests can preview the dist output, then
// assert the production bundle ships no React .development.js chunks.
test("build no-typescript app", async () => {
  const cwd = path.resolve(".");
  // tinyexec does NOT throw on a non-zero exit by default, so assert the build
  // actually succeeded — otherwise a broken build would silently pass this gate
  // and production tests would run against stale/partial dist.
  const build = await x("pnpm", ["build"], { nodeOptions: { cwd } });
  expect(
    build.exitCode,
    `pnpm build failed (exit ${build.exitCode}).\n--- stdout ---\n${build.stdout}\n--- stderr ---\n${build.stderr}`,
  ).toBe(0);

  const devArtifacts = findDevReactArtifacts(path.join(cwd, "dist"));
  expect(
    devArtifacts,
    `Production build must not emit React .development.js chunks. Found:\n${devArtifacts
      .map((f) => `  ${path.relative(cwd, f)}`)
      .join("\n")}`,
  ).toEqual([]);

  // Primary guard: the SSR/RSC entry bundles must not balloon (dev React inlined).
  for (const rel of ENTRY_BUNDLES) {
    const bytes = fs.statSync(path.join(cwd, "dist", rel)).size;
    expect(
      bytes,
      `dist/${rel} is ${bytes} bytes (>= ${MAX_ENTRY_BYTES}). NODE_ENV was likely not folded at build, inlining React's dev branches. See AGENTS.md Bundle Hygiene rule #2.`,
    ).toBeLessThan(MAX_ENTRY_BYTES);
  }
});
