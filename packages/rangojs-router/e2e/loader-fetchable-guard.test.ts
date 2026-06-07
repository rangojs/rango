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
// Production — direct HTTP with runtime-discovered hashed IDs
// ---------------------------------------------------------------------------
test.describe("loader fetchable guard (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  // Discover production hashed loader IDs at test time via a test helper route
  let loaderIds: {
    fetchable: string;
    nonFetchable: string;
    withMiddleware: string;
  };

  test.beforeAll(async ({ request }) => {
    const res = await request.get(f.url("/__test/loader-ids"), {
      headers: { Accept: "application/json" },
    });
    expect(res.status()).toBe(200);
    const json = await res.json();
    loaderIds = json;
  });

  test("fetchable loader is accessible via _rsc_loader endpoint", async ({
    request,
  }) => {
    const response = await request.get(
      f.url(
        `/fetch-loader?_rsc_loader=${encodeURIComponent(loaderIds.fetchable)}`,
      ),
      { headers: { Accept: "text/x-component" } },
    );

    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain("Fetched via GET");
  });

  test("non-fetchable loader is rejected with 403 via _rsc_loader endpoint", async ({
    request,
  }) => {
    const response = await request.get(
      f.url(
        `/fetch-loader?_rsc_loader=${encodeURIComponent(loaderIds.nonFetchable)}`,
      ),
      { headers: { Accept: "text/x-component" } },
    );

    expect(response.status()).toBe(403);
    const text = await response.text();
    expect(text).toContain("is not fetchable");
  });

  test("fetchable loader with middleware object form is accessible", async ({
    request,
  }) => {
    const response = await request.get(
      f.url(
        `/fetch-loader?_rsc_loader=${encodeURIComponent(loaderIds.withMiddleware)}&_rsc_loader_params=` +
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

    await expect(testId(page, "index-page")).toBeVisible();
  });

  test("unknown loader ID returns 404", async ({ request }) => {
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
