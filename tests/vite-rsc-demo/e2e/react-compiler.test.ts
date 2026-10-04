import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { useFixture } from "./fixture";

/**
 * React Compiler verification for the vite-rsc-demo app (non-Cloudflare path,
 * where rango() supplies @vitejs/plugin-rsc).
 *
 * The compiler is plugin-react's native `compiler` option, backed by
 * oxc-transform-react (see vite-rsc-demo/vite.config.ts). The whole
 * vite-rsc-demo e2e suite already runs against compiler-transformed client
 * code; this file additionally pins that the compiler is actually on (so it
 * cannot be silently disabled), that it stays client-only, and that Fast
 * Refresh still lands in compiled modules (plugin-react hands refresh to the
 * same native pass and disables Vite's own injection while `compiler` is on).
 *
 * Markers:
 * - Per-module (dev): every compiled module imports the cache allocator from
 *   `react/compiler-runtime` and calls `_c(n)`. These are present regardless of
 *   what a given component compiles to.
 * - Aggregate bundle (production): a compiled component reads input-independent
 *   memo-cache slots back with `$[i] === Symbol.for("react.memo_cache_sentinel")`.
 *   That triple-`=` form is emitted only by compiled components (React core's
 *   lone sentinel *definition* uses a single `=`), so it has a zero baseline
 *   without the compiler. It is component-dependent, so it is asserted over the
 *   whole client bundle rather than a single module.
 */

const ROOT = ".";
const CLIENT_ASSETS_DIR = resolve(ROOT, "dist/client/assets");
// Server environments — used to assert the compiler did NOT touch them.
const SERVER_DIRS = [resolve(ROOT, "dist/rsc"), resolve(ROOT, "dist/ssr")];

const COMPILED_MARKER = /===\s*Symbol\.for\(\s*["'`]react\.memo_cache_sentinel/;

function readClientBundle(): string {
  return readdirSync(CLIENT_ASSETS_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(CLIENT_ASSETS_DIR, f), "utf-8"))
    .join("\n");
}

// Concatenate every .js chunk under dist/rsc and dist/ssr (index.js + assets/).
function readServerBundles(): string {
  const parts: string[] = [];
  for (const dir of SERVER_DIRS) {
    const index = join(dir, "index.js");
    if (existsSync(index)) parts.push(readFileSync(index, "utf-8"));
    const assets = join(dir, "assets");
    if (existsSync(assets)) {
      for (const file of readdirSync(assets).filter((f) => f.endsWith(".js"))) {
        parts.push(readFileSync(join(assets, file), "utf-8"));
      }
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Dev mode — Vite dev server serves transformed source on demand.
// ---------------------------------------------------------------------------

test.describe("react compiler (vite-rsc-demo)", () => {
  const f = useFixture({ root: ROOT, mode: "dev" });

  test("dev: client component is compiled (memo-cache output)", async ({
    page,
  }) => {
    const res = await page.request.get(
      f.url("/src/components/AddToCartButton.tsx"),
    );
    expect(res.ok()).toBe(true);
    const source = await res.text();
    // Universal per-module compiler signature: the compiler-runtime import and
    // the `_c(n)` memo-cache allocation. An un-compiled module has neither.
    expect(source).toContain("compiler-runtime");
    expect(source).toMatch(/_c\(/);
    expect(source).toContain("$RefreshReg$(");
  });
});

// ---------------------------------------------------------------------------
// Production mode — read the built bundles off disk.
// ---------------------------------------------------------------------------

test.describe("react compiler (vite-rsc-demo) (production)", () => {
  useFixture({ root: ROOT, mode: "build" });

  test("production: client bundle contains compiled memo-cache output", () => {
    expect(readClientBundle()).toMatch(COMPILED_MARKER);
  });

  test("production: server (rsc/ssr) bundles are NOT compiled (client-only)", () => {
    // plugin-react passes `reactCompiler: false` to oxc-transform-react when
    // `consumer === "server"`, so only the client environment is compiled. The
    // rsc/ssr bundles carry React core's bare sentinel definition but never the
    // compiled comparison form.
    expect(readServerBundles()).not.toMatch(COMPILED_MARKER);
  });
});
