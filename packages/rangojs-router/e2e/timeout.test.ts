import path from "node:path";
import { expect, test } from "@playwright/test";
import { x } from "tinyexec";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * Poll __test/last-error until an error with the expected phase is recorded.
 */
async function waitForOnError(
  page: import("@playwright/test").Page,
  errorUrl: string,
  expectedPhase: string,
  timeout = 5000,
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
          if (data.data && data.data.phase === expectedPhase) {
            result = data.data;
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
  // Warm the Vite module graph before tests run. The first cold request on CI
  // can exceed the 2s timeout due to module compilation. Retry until a 200
  // confirms all modules are compiled, then subsequent tests get warm responses.
  test.beforeAll(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(f.url("/"));
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  test("index page loads without timeout", async ({ page }) => {
    const response = await page.goto(f.url("/"));
    expect(response?.status()).toBe(200);
    await expect(page.locator('[data-testid="index-page"]')).toBeVisible({
      timeout: 5000,
    });
  });

  test("slow render returns 504 with timeout phase header", async ({
    request,
  }) => {
    const response = await request.get(f.url("/timeout/slow-render"));
    expect(response.status()).toBe(504);
    expect(response.headers()["x-rango-timeout-phase"]).toBe("render-start");
    expect(await response.text()).toBe("Request timed out");
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
    expect(body.data.ok).toBe(true);
  });

  test("onError records timeout with metadata", async ({ page }) => {
    // Clear any previous error
    await page.request.get(f.url("/__test/last-error"));

    // Trigger a slow render (will timeout)
    await page.request.get(f.url("/timeout/slow-render"));

    const error = await waitForOnError(
      page,
      f.url("/__test/last-error"),
      "handler",
    );

    expect(error.phase).toBe("handler");
    expect(error.message).toContain("Request timed out during render-start");
    expect(error.metadata).toBeDefined();
    expect(error.metadata!.timeout).toBe(true);
    expect(error.metadata!.phase).toBe("render-start");
  });

  test("slow action triggers onError with action phase", async ({ page }) => {
    await page.goto(f.url("/timeout/slow-action"));
    await waitForHydration(page);

    // Clear any previous error
    await page.request.get(f.url("/__test/last-error"));

    // Submit the form that triggers the slow server action
    await page.locator('[data-testid="slow-action-btn"]').click();

    const error = await waitForOnError(
      page,
      f.url("/__test/last-error"),
      "action",
      10000,
    );

    expect(error.phase).toBe("action");
    expect(error.message).toContain("Request timed out during action");
    expect(error.metadata).toBeDefined();
    expect(error.metadata!.timeout).toBe(true);
    expect(error.metadata!.phase).toBe("action");
  });
}

test.describe("timeout", () => {
  test.setTimeout(60000);

  const f = useFixture({
    root: "./e2e/e2e-timeout",
    mode: "dev",
    isolatedServer: true,
  });

  timeoutTests(f);
});

test.describe("timeout (production)", () => {
  const f = useFixture({
    root: "./e2e/e2e-timeout",
    mode: "build",
    isolatedServer: true,
  });

  test.setTimeout(120000);

  // Build the e2e-timeout app (the shared "build" setup only builds test-app)
  test.beforeAll(async () => {
    const cwd = path.resolve("./e2e/e2e-timeout");
    await x("pnpm", ["build"], { nodeOptions: { cwd } });
  });

  timeoutTests(f);
});
