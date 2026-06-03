import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { x } from "tinyexec";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * React Compiler verification for the e2e-basic app — the non-Cloudflare path,
 * where rango() itself supplies @vitejs/plugin-rsc.
 *
 * The compiler is wired exactly like the @vitejs/plugin-rsc example: a
 * top-level @rolldown/plugin-babel running reactCompilerPreset(), ordered after
 * react() and before rango() (see e2e-basic/vite.config.ts). plugin-react v6
 * runs oxc and no longer carries Babel, so the compiler must be its own plugin.
 *
 * This suite proves the compiler actually transformed components in BOTH dev and
 * production — not just that the config parses.
 *
 * Two markers, chosen for where they are reliable:
 * - Per-module (dev): every compiled module imports the cache allocator from
 *   `react/compiler-runtime` and calls `_c(n)`. Present regardless of what a
 *   given component compiles to, so it is the right signal for a single module.
 * - Aggregate bundle (production): React Compiler reads input-independent
 *   memo-cache slots back with `$[i] === Symbol.for("react.memo_cache_sentinel")`.
 *   The triple-`=` comparison form is emitted only by compiled components (React
 *   core's lone sentinel *definition* uses a single `=` assignment), so it has a
 *   zero baseline without the compiler (verified against the un-compiled mini
 *   app: 0 matches there vs 21+ once compiled) and survives minification
 *   identically in the vanilla-vite and cloudflare builds. It is
 *   component-dependent, so it is asserted over the whole client bundle.
 */

const E2E_BASIC_ROOT = "./e2e/e2e-basic";
const CLIENT_ASSETS_DIR = resolve(E2E_BASIC_ROOT, "dist/client/assets");
// Server environments — used to assert the compiler did NOT touch them.
const SERVER_DIRS = [
  resolve(E2E_BASIC_ROOT, "dist/rsc"),
  resolve(E2E_BASIC_ROOT, "dist/ssr"),
];

// `$[i] === Symbol.for("react.memo_cache_sentinel")` across quote styles
// (the minifier may rewrite "..." to `...`) and minified spacing. Emitted by
// compiled components only.
const COMPILED_MARKER = /===\s*Symbol\.for\(\s*["'`]react\.memo_cache_sentinel/;

// Build e2e-basic once at file level so the production describe reuses dist.
// Mirrors smoke.test.ts / loader-types-basic.test.ts, which also drive this app.
test.beforeAll(async () => {
  await x("pnpm", ["build"], { nodeOptions: { cwd: resolve(E2E_BASIC_ROOT) } });
});

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
// Dev mode — isolated Vite dev server serves transformed source on demand.
// ---------------------------------------------------------------------------

test.describe("react compiler (e2e-basic)", () => {
  test.describe.configure({ mode: "serial" });

  const f = useFixture({
    root: E2E_BASIC_ROOT,
    mode: "dev",
    isolatedServer: true,
    readyPath: "/app",
  });

  test("dev: client component is compiled (memo-cache output)", async ({
    page,
  }) => {
    // Fetch the dev-transformed client module straight from Vite. The compiler
    // runs in the babel pipeline, so the served module carries the universal
    // per-module signature: the react/compiler-runtime allocator import and a
    // `_c(n)` memo-cache allocation. (The sentinel *comparison* form is only
    // emitted for input-independent JSX, so it is asserted at the aggregate
    // bundle level in production, not per-module here.)
    const res = await page.request.get(
      f.url("/src/components/UseHrefDemo.tsx"),
    );
    expect(res.ok()).toBe(true);
    const source = await res.text();
    expect(source).toContain("compiler-runtime");
    expect(source).toMatch(/_c\(/);
  });

  test("dev: compiled app still renders and hydrates", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/app"));
    await waitForHydration(page);
    await expect(page.getByTestId("home-page")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Production mode — read the built client bundle off disk.
// ---------------------------------------------------------------------------

test.describe("react compiler (e2e-basic) (production)", () => {
  const f = useFixture({
    root: E2E_BASIC_ROOT,
    mode: "build",
    buildCommand: "true", // already built at file level
    readyPath: "/app",
  });

  test("production: client bundle contains compiled memo-cache output", () => {
    expect(readClientBundle()).toMatch(COMPILED_MARKER);
  });

  test("production: server (rsc/ssr) bundles are NOT compiled (client-only preset)", () => {
    // reactCompilerPreset() gates on `applyToEnvironmentHook: consumer ===
    // "client"`, so only the client environment is compiled. The rsc/ssr
    // bundles therefore carry React core's bare sentinel *definition*
    // (`= Symbol.for(...)`) but never the compiled comparison form
    // (`=== Symbol.for(...)`). Pinning this catches both a regression in our
    // wiring and an upstream change to the preset's environment scope.
    expect(readServerBundles()).not.toMatch(COMPILED_MARKER);
  });

  test("production: compiled app still renders and hydrates", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/app"));
    await waitForHydration(page);
    await expect(page.getByTestId("home-page")).toBeVisible();
  });
});
