import { expect, test } from "@playwright/test";
// The e2e harness has its own entry so it loads under Playwright's plain
// (non-Vite) loader: the unit barrel `@rangojs/router/testing` re-exports
// `dispatch`/`runMiddleware`, which reach the router manifest's Vite-only
// `@rangojs/router:version` virtual module and cannot resolve here.
import { createRangoE2E } from "@rangojs/router/testing/e2e";

/**
 * Worked example of the consumer e2e harness (`@rangojs/router/testing/e2e`),
 * exercised against the repo's test-app over BOTH dev and production.
 *
 * Rather than spawn its own server via `useFixture`/`parityDescribe` (which
 * would build/serve a fresh instance), this committed example reuses the shared
 * dev (:5188) and preview (:5189) servers from playwright.config.ts. The config
 * buckets by the `(production)` describe-title grep, so the two describes below
 * run the same assertions against their project's baseURL via RELATIVE
 * `page.goto`. `useFixture`/`parityDescribe` are demonstrated in the docs;
 * keeping this example server-light keeps CI cheap.
 */

const { testId, waitForHydration, expectParity, rangoMatchers } =
  createRangoE2E({ test, expect });

// The harness ships the `toHaveRangoPathname` type augmentation, so no local
// `declare global` is needed — `expect(page).toHaveRangoPathname(...)` is typed.
//
// `rangoMatchers` keeps the receiver (the page) as its first explicit argument,
// which is the shape `expect.extend` expects; cast through its parameter type so
// the example reads as a plain `expect.extend(rangoMatchers)`.
expect.extend(rangoMatchers as unknown as Parameters<typeof expect.extend>[0]);

// The same specs run in both buckets. Relative navigation resolves against the
// active project's baseURL, so the dev describe hits :5188 and the production
// describe hits :5189 with no per-test server wiring.
function harnessSpecs(): void {
  test("loads home, waits for hydration, asserts a testid and pathname", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForHydration(page);

    await expect(testId(page, "page-title")).toBeVisible();
    await expect(testId(page, "page-title")).toHaveText("Products");
    await expect(page).toHaveRangoPathname("/");
  });

  test("navigates home -> /blog and asserts the destination pathname", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForHydration(page);

    await testId(page, "link-status-blog").click();

    await expect(testId(page, "blog-index-page")).toBeVisible();
    await expect(testId(page, "blog-title")).toHaveText("Blog");
    await expect(page).toHaveRangoPathname("/blog");
  });

  test("expectParity: /blog navigation matches across JS and no-JS", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForHydration(page);

    // The no-JS path runs in a fresh context with no project baseURL, so resolve
    // the relative navigate intent against the current project's origin.
    const baseURL = new URL(page.url()).origin;
    await expectParity(
      page,
      { navigate: "/blog" },
      { observe: ["blog-title"], baseURL },
    );
  });

  test("expectParity: parity-counter submit matches across JS and no-JS", async ({
    page,
  }) => {
    // The /parity-counter form posts an `amount` to a server action that
    // increments a cookie-scoped count and re-renders it. The harness applies
    // the submit on the JS page, then again in a fresh no-JS context against the
    // same server. Because the count lives in a per-context cookie, both
    // transports start at 0 and reach the same value after a single submit, and
    // their whole cookie jars match — exercising expectParity's submit path
    // (applyIntent fill + click, settleSubmit, jar compare) end to end.
    await page.goto("/parity-counter");
    await waitForHydration(page);

    const baseURL = new URL(page.url()).origin;
    await expectParity(
      page,
      { submit: { testId: "parity-counter-form", data: { amount: "1" } } },
      { observe: ["parity-counter-value"], baseURL },
    );
  });
}

// Dev bucket: title WITHOUT "(production)" -> runs against the :5188 dev server.
test.describe("consumer-testing-harness", () => {
  harnessSpecs();
});

// Production bucket: title WITH "(production)" -> runs against the :5189 preview
// server. Same specs, so dev/prod parity of the harness itself is pinned.
test.describe("consumer-testing-harness (production)", () => {
  harnessSpecs();
});
