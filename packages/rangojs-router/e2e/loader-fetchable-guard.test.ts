/**
 * E2E: Fetchable loader endpoint guard.
 *
 * Verifies that only loaders created with `createLoader(fn, true)` or
 * `createLoader(fn, { ... })` are reachable via the _rsc_loader endpoint.
 * Non-fetchable loaders (plain `createLoader(fn)`) must be rejected with 403.
 */
import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

// ---------------------------------------------------------------------------
// Dev — direct HTTP requests with dev-style loader IDs
// ---------------------------------------------------------------------------
test.describe("loader fetchable guard", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test.setTimeout(30000);

  test("fetchable loader is accessible via _rsc_loader endpoint", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/fetch-loader?_rsc_loader=src/loaders.tsx%23FetchableTestLoader"),
      { headers: { Accept: "text/x-component" } },
    );

    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain("Fetched via GET");
  });

  test("non-fetchable loader is rejected with 403 via _rsc_loader endpoint", async ({
    request,
  }) => {
    // ProductsLoader is createLoader(fn) — no fetchable flag
    const response = await request.get(
      f.url("/fetch-loader?_rsc_loader=src/loaders.tsx%23ProductsLoader"),
      { headers: { Accept: "text/x-component" } },
    );

    expect(response.status()).toBe(403);
    const text = await response.text();
    expect(text).toContain("is not fetchable");
  });

  test("fetchable loader with middleware object form is accessible", async ({
    request,
  }) => {
    // ProtectedLoader is createLoader(fn, { middleware: [...] })
    const response = await request.get(
      f.url(
        "/fetch-loader?_rsc_loader=src/loaders.tsx%23ProtectedLoader&_rsc_loader_params=" +
          encodeURIComponent(JSON.stringify({ authToken: "valid-token" })),
      ),
      { headers: { Accept: "text/x-component" } },
    );

    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain("protected");
  });

  test("non-fetchable loader still works through SSR ctx.use()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // The shop index page uses ProductsLoader (non-fetchable) via ctx.use()
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Verify the non-fetchable loader data rendered correctly through SSR
    await expect(testId(page, "index-page")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Production — browser-based + direct HTTP
// ---------------------------------------------------------------------------
test.describe("loader fetchable guard (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("fetchable loader works via browser in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fetch-loader"));
    await waitForHydration(page);

    // Trigger a client-side fetch — exercises the _rsc_loader endpoint
    // with the production hashed ID
    await testId(page, "fetch-loader-btn-default").click();
    await expect(testId(page, "fetch-loader-data")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "fetch-loader-message")).toContainText(
      "Fetched via GET",
    );
  });

  test("non-fetchable loader still works through SSR in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // The shop index page uses ProductsLoader (non-fetchable) via ctx.use()
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(testId(page, "index-page")).toBeVisible();
  });

  test("unknown loader ID returns 404 in production", async ({ request }) => {
    // A fabricated ID that doesn't exist in the production manifest
    const response = await request.get(
      f.url("/fetch-loader?_rsc_loader=nonexistent_loader_id"),
      { headers: { Accept: "text/x-component" } },
    );

    expect(response.status()).toBe(404);
    const text = await response.text();
    expect(text).toContain("not found");
  });
});
