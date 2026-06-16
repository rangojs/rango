import { expect, test } from "@playwright/test";
import path from "node:path";
import { x } from "tinyexec";

/**
 * Issue #587 — build-level coverage through the real rango Vite plugin.
 *
 * Uses a DEDICATED fixture app (e2e/prerender-onerror) with its own projectRoot, so
 * its dist/ and staged-asset dir are never shared with — or raced by — any other e2e
 * app's build. (The rango plugin's closeBundle writes the prerender/static manifests
 * straight into <projectRoot>/dist/rsc regardless of Vite's build.write, so a shared
 * app can't be isolated by write:false alone — only a separate projectRoot works.)
 *
 * The app exports an erroring Prerender route (PrerenderBoom, registered only when
 * RANGO_TEST_PRERENDER_ERROR is set; its render reads the unavailable ctx.env) and a
 * Static handler (StaticBoom, throws only when RANGO_TEST_STATIC_ERROR is set).
 * vite.config flips prerender.onError to "warn" when RANGO_TEST_PRERENDER_ONERROR=warn.
 *
 * Before the #587 fix the router error boundary swallowed the throw and the build
 * baked the error page as a healthy artifact (logged OK, served as a 200). These pin
 * the post-fix contract end-to-end through the compiled plugin:
 *   - default: the build FAILS, naming the URL/handler and the original error;
 *   - prerender.onError "warn": the build SUCCEEDS and the entry is skipped (not baked);
 *   - both Prerender routes and Static() handlers go through the same policy.
 *
 * Build-only by design (explicit gap): #587 is a build-time bug and prerender.onError
 * is build config. The dev `/__rsc_prerender` endpoint tweak (router-discovery.ts) is
 * a cosmetic log refinement (stay quiet on Skip) on a path that serves ONLY non-Node
 * runtimes — and the repo's only non-Node dev fixture (cloudflare-basic) uses
 * buildEnv:"auto", where ctx.env is available at build, so the render-error repro
 * cannot occur there. The behavioral change (matchForPrerender re-throwing instead of
 * baking) is unit-covered (src/router/__tests__/prerender-render-error.test.tsx).
 * The endpoint's catch/404-fallthrough is therefore a deliberate untested gap.
 */
const cwd = path.resolve("./e2e/prerender-onerror");

function buildEnv(gates: Record<string, string>): Record<string, string> {
  return { ...process.env, ...gates } as Record<string, string>;
}

test.describe("prerender render error (production)", () => {
  test.describe.configure({ timeout: 180_000 });

  test("fails the build by default, naming the URL and the original error", async () => {
    const res = await x("pnpm", ["build"], {
      nodeOptions: { cwd, env: buildEnv({ RANGO_TEST_PRERENDER_ERROR: "1" }) },
      throwOnError: false,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    expect(
      res.exitCode,
      `build should exit non-zero; output:\n${out}`,
    ).not.toBe(0);
    // The ORIGINAL render error reaches the build (not a baked error page).
    expect(out).toContain("ctx.env is not available during pre-rendering");
    expect(out).toMatch(/FAIL\s+\/prerender-boom/);
  });

  test('prerender.onError "warn" skips the route and the build succeeds', async () => {
    const res = await x("pnpm", ["build"], {
      nodeOptions: {
        cwd,
        env: buildEnv({
          RANGO_TEST_PRERENDER_ERROR: "1",
          RANGO_TEST_PRERENDER_ONERROR: "warn",
        }),
      },
      throwOnError: false,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    expect(
      res.exitCode,
      `warn build should succeed (exit 0); output:\n${out}`,
    ).toBe(0);
    expect(out).toMatch(/WARN\s+\/prerender-boom.*prerender\.onError: "warn"/);
    // Skipped, not baked.
    expect(out).toContain("Pre-render complete: 0 done, 1 skipped");
  });

  test("a Static() handler render error also fails the build by default", async () => {
    // No prerender error this run, so the prerender phase succeeds and the build
    // reaches renderStaticHandlers, where StaticBoom throws and the same
    // prerender.onError policy (default "fail") fails the build.
    const res = await x("pnpm", ["build"], {
      nodeOptions: { cwd, env: buildEnv({ RANGO_TEST_STATIC_ERROR: "1" }) },
      throwOnError: false,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    expect(
      res.exitCode,
      `static build should exit non-zero; output:\n${out}`,
    ).not.toBe(0);
    expect(out).toContain("static build-time render failure");
    expect(out).toMatch(/FAIL\s+StaticBoom/);
  });

  test('a Static() handler under prerender.onError "warn" is skipped, not baked', async () => {
    const res = await x("pnpm", ["build"], {
      nodeOptions: {
        cwd,
        env: buildEnv({
          RANGO_TEST_STATIC_ERROR: "1",
          RANGO_TEST_PRERENDER_ONERROR: "warn",
        }),
      },
      throwOnError: false,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    expect(
      res.exitCode,
      `static warn build should succeed (exit 0); output:\n${out}`,
    ).toBe(0);
    expect(out).toMatch(/WARN\s+StaticBoom.*prerender\.onError: "warn"/);
    // Skipped, not baked: the static render step reports it as skipped.
    expect(out).toContain("Static render complete: 0 done, 1 skipped");
  });
});
