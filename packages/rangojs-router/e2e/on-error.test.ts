import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * Poll __test/last-error until an error with the expected phase is recorded.
 * Replaces fixed waitForTimeout calls for deterministic error propagation checks.
 *
 * Note: __test/last-error resets after each read, so the poll must check without
 * consuming until we find the right phase. We use a non-resetting peek approach:
 * each poll iteration fetches, and the endpoint returns + resets. If the phase
 * doesn't match, the error is lost — so we only poll after the triggering action.
 */
async function waitForOnError(
  page: import("@playwright/test").Page,
  errorUrl: string,
  expectedPhase: string,
  timeout = 10000,
): Promise<{ phase: string; message: string; actionId?: string }> {
  let result: any = null;
  await expect
    .poll(
      async () => {
        try {
          const response = await page.request.get(errorUrl);
          const data = await response.json();
          // The endpoint returns an array of error records (or null)
          const log = data.data;
          if (Array.isArray(log)) {
            const match = log.find(
              (entry: any) => entry.phase === expectedPhase,
            );
            if (match) {
              result = match;
              return true;
            }
          }
        } catch {
          // JSON parse may fail if server is mid-restart; retry
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
 * Shared onError tests run against both dev and production.
 *
 * Contract under test:
 * - Action errors report phase="action"
 * - Response route handler errors report phase="handler"
 * - Error message is propagated to the callback
 */
function onErrorTests(f: ReturnType<typeof useFixture>) {
  test("action error reports phase='action'", async ({ page }) => {
    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Clear any previous errors
    await page.request.get(f.url("/__test/clear-error-log"));

    // Trigger action that throws
    await page.locator('[data-testid="throw-error-btn"]').click();

    const error = await waitForOnError(
      page,
      f.url("/__test/last-error"),
      "action",
    );

    expect(error.phase).toBe("action");
    // onError always receives the real message (server-side callback)
    expect(error.message).toBe("Action error for onError test");
  });

  test("handler error reports phase='handler'", async ({ page }) => {
    // Clear any previous errors
    await page.request.get(f.url("/__test/clear-error-log"));

    // Hit a response route that throws — triggers onError with phase="handler"
    const response = await page.request.get(
      f.url("/__test/throw-handler-error"),
    );

    // The response route should return a JSON error envelope
    expect(response.status()).toBe(500);

    const error = await waitForOnError(
      page,
      f.url("/__test/last-error"),
      "handler",
    );

    expect(error.phase).toBe("handler");
    expect(error.message).toBe("Handler error for onError test");
  });
}

test.describe("onError", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  onErrorTests(f);
});

test.describe("onError (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  onErrorTests(f);
});

function onErrorProgressiveEnhancementTests(f: ReturnType<typeof useFixture>) {
  test.use({ javaScriptEnabled: false });

  test("useActionState PE form error reports phase='action' with stable actionId", async ({
    page,
  }) => {
    await page.goto(f.url("/location-state"));

    // Clear any previous errors
    await page.request.get(f.url("/__test/clear-error-log"));

    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator('[data-testid="throw-form-error-submit-btn"]').click(),
    ]);

    const error = await waitForOnError(
      page,
      f.url("/__test/last-error"),
      "action",
    );

    expect(error.phase).toBe("action");
    expect(error.message).toBe("Form action error for onError test");
    expect(error.actionId).toMatch(/#throwFormActionError$/);
  });
}

test.describe("onError progressive enhancement", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  onErrorProgressiveEnhancementTests(f);
});

test.describe("onError progressive enhancement (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  onErrorProgressiveEnhancementTests(f);
});
