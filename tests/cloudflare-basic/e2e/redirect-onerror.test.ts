import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * Poll /__test/last-error until an error with the expected phase is recorded.
 * Event-driven rather than a fixed timeout: the redirect action POST is awaited
 * first (by then the server has already invoked onError), so this read is
 * deterministic, but we poll anyway to absorb cold-isolate lag under workerd.
 */
async function waitForOnError(
  page: import("@playwright/test").Page,
  errorUrl: string,
  expectedPhase: string,
  timeout = 20000,
): Promise<{ phase: string; message: string }> {
  let result: any = null;
  await expect
    .poll(
      async () => {
        try {
          const response = await page.request.get(errorUrl);
          const log = await response.json();
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
          // JSON parse may fail if the worker is mid-restart; retry.
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
 * Dual-app coverage of the redirect Flight onError contract (test-app sibling:
 * e2e/on-error.test.ts). createRedirectFlightResponse used to be the only RSC
 * renderToReadableStream call with no onError, so a redirect whose
 * locationState fails Flight serialization was invisible to onError. The action
 * throws a redirect carrying a function in locationState: the redirect itself
 * is valid (200 Flight payload) but serialization fails under workerd, and that
 * failure must reach onError("rendering").
 */
function redirectOnErrorSuite(f: ReturnType<typeof useFixture>) {
  test("redirect with non-serializable locationState reports phase='rendering'", async ({
    page,
  }) => {
    await page.goto(f.url("/action-location-state"));
    await waitForHydration(page);

    // Clear any previous errors.
    await page.request.get(f.url("/__test/clear-error-log"));

    // Wait for the action POST to complete before polling: by the time the
    // ?_rsc_action= response returns, the server has already invoked onError.
    const actionResponse = page.waitForResponse(
      (resp) =>
        resp.request().method() === "POST" &&
        resp.url().includes("_rsc_action="),
      { timeout: 30000 },
    );
    await testId(page, "redirect-nonserializable-btn").click();
    await actionResponse;

    const error = await waitForOnError(
      page,
      f.url("/__test/last-error"),
      "rendering",
    );

    expect(error.phase).toBe("rendering");
  });
}

// -- Dev mode --

test.describe("redirect onError (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  redirectOnErrorSuite(f);
});

// -- Production mode --

test.describe("redirect onError (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  test.setTimeout(120000);
  redirectOnErrorSuite(f);
});
