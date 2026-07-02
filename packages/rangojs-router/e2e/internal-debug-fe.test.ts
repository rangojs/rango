import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * INTERNAL_RANGO_DEBUG must reach the CLIENT (browser) debug logs by just setting
 * the env var -- not only the dev-server/server logs.
 *
 * The flag normally reaches the client via a `__RANGO_DEBUG__` define that
 * internal-debug.ts reads through `typeof __RANGO_DEBUG__`. In dev Vite delivers
 * that define only as an injected client global whose presence varies across
 * consumer setups, so the module can fall through to `process.env` (undefined in
 * the browser) and the FE flag silently stays false while server logs work. The
 * discovery plugin's `transform` (injectClientDebugFlag) bakes the resolved flag
 * into the client module so it no longer depends on that global.
 *
 * Dev runs on the default test-app. Production runs on e2e-basic: the default
 * test-app's production fixture reuses a single shared (flagless) build, but
 * e2e-basic is a non-default root, so its fixture rebuilds with the env var --
 * exercising the transform in a real production bundle, the path the old client
 * `define` was unreliable on. The transform itself is mode-independent and is
 * additionally pinned by `src/vite/__tests__/inject-client-debug.test.ts`.
 *
 * `[Browser][req:` is the browserDebugLog prefix -- it only appears when the
 * client debug flag is on, never from the always-on console.error logging.
 */
const DEBUG_PREFIX = "[Browser][req:";

function collectClientDebug(page: Page): string[] {
  const logs: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().includes(DEBUG_PREFIX)) logs.push(msg.text());
  });
  return logs;
}

async function softNavigate(page: Page, f: ReturnType<typeof useFixture>) {
  await page.goto(f.url("/"));
  await waitForHydration(page);
  await page.locator('[data-testid="product-link-product-a"]').click();
  await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
}

const withFlag = () =>
  useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "true" } },
  });

// Structural: the transform bakes the flag into the served client module, so FE
// debug no longer depends on Vite injecting the __RANGO_DEBUG__ global. Without
// the transform the served module is the `typeof __RANGO_DEBUG__` fallback, so the
// `not.toContain("__RANGO_DEBUG__")` assertion fails.
test.describe("INTERNAL_RANGO_DEBUG client injection (dev)", () => {
  const f = withFlag();

  test("client internal-debug module is baked, not __RANGO_DEBUG__-dependent", async ({
    page,
  }) => {
    const mods: string[] = [];
    page.on("response", async (res) => {
      if (res.url().includes("internal-debug")) {
        try {
          mods.push(await res.text());
        } catch {}
      }
    });

    await page.goto(f.url("/"));
    await waitForHydration(page);

    const body = mods.join("\n");
    expect(body).toContain("INTERNAL_RANGO_DEBUG = true");
    expect(body).not.toContain("__RANGO_DEBUG__");
  });
});

// Behavioral: with the flag set, a soft navigation emits FE debug logs.
test.describe("INTERNAL_RANGO_DEBUG FE logs (dev)", () => {
  const f = withFlag();

  test("a soft navigation emits FE debug logs to the browser console", async ({
    page,
  }) => {
    const debugLogs = collectClientDebug(page);
    await softNavigate(page, f);
    expect(debugLogs.length).toBeGreaterThan(0);
  });
});

// Negative: without the flag the client debug logs stay silent.
test.describe("INTERNAL_RANGO_DEBUG off keeps FE debug silent (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test("a soft navigation emits no FE debug logs", async ({ page }) => {
    const debugLogs = collectClientDebug(page);
    await softNavigate(page, f);
    expect(debugLogs).toEqual([]);
  });
});

// Production: e2e-basic is a non-default root, so the fixture rebuilds it with the
// env var at build time (the shared-build skip in fixture.ts applies only to the
// default test-app). This exercises the transform in a real production bundle.
test.describe("INTERNAL_RANGO_DEBUG FE logs (production)", () => {
  // No isolatedServer: a cold isolated build exceeds the beforeAll timeout. The
  // warm build (like loader-types-basic) stays fast; cliOptions.env still flows
  // to the build command so the bundle is built with the flag. The production
  // project is serial (fullyParallel: false), so the per-build e2e-basic dist
  // does not race other e2e-basic production suites.
  const f = useFixture({
    root: "./e2e/e2e-basic",
    mode: "build",
    // e2e-basic mounts under basename /app; the readiness probe must hit it.
    readyPath: "/app",
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "true" } },
  });

  test("a soft navigation emits FE debug logs to the browser console", async ({
    page,
  }) => {
    const debugLogs = collectClientDebug(page);
    await page.goto(f.url("/app/shop"));
    await waitForHydration(page);
    await page.getByTestId("product-link-1").click();
    await expect(page.getByTestId("product-modal")).toBeVisible();
    expect(debugLogs.length).toBeGreaterThan(0);
  });
});
