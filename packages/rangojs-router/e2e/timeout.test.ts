import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * Poll __test/last-error until an error with the expected phase is recorded.
 */
async function waitForOnError(
  page: import("@playwright/test").Page,
  errorUrl: string,
  expectedPhase: string,
  timeout = 15000,
): Promise<{
  phase: string;
  message: string;
  metadata?: Record<string, unknown>;
}> {
  let result: any = null;
  await expect
    .poll(
      async () => {
        try {
          const response = await page.request.get(errorUrl);
          const data = await response.json();
          if (data && data.phase === expectedPhase) {
            result = data;
            return true;
          }
        } catch {
          // JSON parse may fail during server restart; retry
        }
        return false;
      },
      {
        timeout,
        message: `Expected onError with phase="${expectedPhase}" within ${timeout}ms`,
      },
    )
    .toBe(true);
  return result;
}

/**
 * Shared timeout tests run against both dev and production.
 *
 * Contract under test:
 * - Slow render exceeding renderStartMs returns 504
 * - Fast render within limit succeeds with 200
 * - Slow response route exceeding renderStartMs returns 504
 * - Fast response route within limit succeeds with 200
 * - Slow action exceeding actionMs triggers onError with phase="action"
 * - 504 responses include X-Rango-Timeout-Phase header
 * - onError is invoked with timeout metadata
 */
function timeoutTests(f: ReturnType<typeof useFixture>) {
  // Warm the Vite module graph for ALL tested routes before tests run.
  // The first cold request on CI can exceed the 2s timeout due to module
  // compilation. We warm each route until we get a response (not necessarily
  // 200 — slow-render and slow-response intentionally timeout with 504).
  test.beforeAll(async ({}, testInfo) => {
    // Hooks default to the 60s project timeout (playwright.config.ts:50), NOT
    // the describe-level 90s/120s test.setTimeout. This warm loop can block far
    // longer: 3 routes (slow-render, slow-response, slow-html-setup) each hold
    // the connection ~10s until the render timeout fires, plus cold Vite
    // compile, and each of the 6 routes carries a 30s retry deadline (6 x 30s =
    // 180s worst case). Raise the hook budget to that upper bound so a loaded CI
    // runner doesn't time the hook out and fail every test in the describe.
    testInfo.setTimeout(180_000);
    const routesToWarm = [
      "/",
      "/timeout/fast-render",
      "/timeout/slow-action",
      "/timeout/slow-html-setup",
      "/timeout/slow-render",
      "/timeout/slow-response",
    ];
    for (const route of routesToWarm) {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(f.url(route));
          // Accept any response — timeout routes return 504 by design
          if (res.status > 0) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });

  test("index page loads without timeout", async ({ page }) => {
    const response = await page.goto(f.url("/"));
    expect(response?.status()).toBe(200);
    await expect(page.locator('[data-testid="index-page"]')).toBeVisible();
  });

  test("fast render succeeds with 200", async ({ request }) => {
    const response = await request.get(f.url("/timeout/fast-render"));
    expect(response.status()).toBe(200);
  });

  test("slow response route returns 504", async ({ request }) => {
    const response = await request.get(f.url("/timeout/slow-response"));
    expect(response.status()).toBe(504);
    expect(response.headers()["x-rango-timeout-phase"]).toBe("render-start");
  });

  test("fast response route succeeds with 200", async ({ request }) => {
    const response = await request.get(f.url("/timeout/fast-response"));
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  test("slow render returns 504 and records the active routine", async ({
    page,
  }) => {
    // Clear any previous error (last-error reads and resets)
    await page.request.get(f.url("/__test/last-error"));

    // Trigger a slow render (will timeout at 10s).
    // On CI under load, server processing delays can push the actual
    // timeout beyond 10s, so allow 30s for polling.
    const response = await page.request.get(f.url("/timeout/slow-render"));
    expect(response.status()).toBe(504);
    expect(response.headers()["x-rango-timeout-phase"]).toBe("render-start");
    expect(await response.text()).toBe("Request timed out");

    const error = await waitForOnError(
      page,
      f.url("/__test/last-error"),
      "handler",
      30000,
    );

    expect(error.phase).toBe("handler");
    expect(error.message).toContain("Request timed out during render-start");
    expect(error.metadata).toBeDefined();
    expect(error.metadata!.timeout).toBe(true);
    expect(error.metadata!.phase).toBe("render-start");
    expect(error.metadata!.routine).toMatchObject({
      name: "document",
      path: ["prepare:full", "match"],
    });
    expect(
      (error.metadata!.routine as { durationMs: number }).durationMs,
    ).toBeGreaterThan(0);
  });

  test("HTML setup timeout reports the foreground render stage", async ({
    page,
  }) => {
    await page.request.get(f.url("/__test/last-error"));

    const response = await page.request.get(f.url("/timeout/slow-html-setup"));
    expect(response.status()).toBe(504);

    const error = await waitForOnError(
      page,
      f.url("/__test/last-error"),
      "handler",
      30000,
    );
    expect(error.metadata?.render).toMatchObject({
      mode: "full",
      phase: "html",
      state: "running",
      completed: 1,
      total: 3,
    });
    expect(error.metadata?.routine).toMatchObject({
      name: "document",
      path: ["render", "html"],
    });
  });

  test("slow action triggers onError with action phase", async ({ page }) => {
    // Retry navigation until we get a 200 — on CI the first page.goto can
    // still hit the 2s timeout if Vite hasn't fully warmed all dependencies.
    let loaded = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await page.goto(f.url("/timeout/slow-action"));
      if (response?.ok()) {
        loaded = true;
        break;
      }
      await page.waitForTimeout(1000);
    }
    expect(loaded).toBe(true);
    await waitForHydration(page);

    // Clear any previous error — drain twice to ensure no stale state
    // from the prior test's slow-render timeout that may still be in flight.
    await page.request.get(f.url("/__test/last-error"));
    await page.waitForTimeout(500);
    await page.request.get(f.url("/__test/last-error"));

    // Submit the form that triggers the slow server action
    await page.locator('[data-testid="slow-action-btn"]').click();

    // The action delays 20s, timeout fires at 10s. On CI under load the
    // server may take extra seconds to start processing the POST, so allow
    // 30s for the timeout to fire and onError to be recorded.
    const error = await waitForOnError(
      page,
      f.url("/__test/last-error"),
      "action",
      30000,
    );

    expect(error.phase).toBe("action");
    expect(error.message).toContain("Request timed out during action");
    expect(error.metadata).toBeDefined();
    expect(error.metadata!.timeout).toBe(true);
    expect(error.metadata!.phase).toBe("action");
  });
}

test.describe("timeout", () => {
  test.setTimeout(90000);

  const f = useFixture({
    root: "./e2e/e2e-timeout",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  timeoutTests(f);
});

test.describe("timeout (production)", () => {
  const f = useFixture({
    root: "./e2e/e2e-timeout",
    mode: "build",
    cliOptions: { env: { INTERNAL_RANGO_DEBUG: "1" } },
  });

  test.setTimeout(120000);

  timeoutTests(f);
});
