import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { waitForHydration, prodDescribe } from "./helper";

/**
 * loader(Def, { ssr: false }) — the SSR-completeness opt-in, pinned
 * on /client-shop/ssr/:slug. The fixture delays are staggered
 * (client-shop-ssr.ts: awaited 400ms, sidecar 1400ms — parallel kickoff means
 * an equal-delay sidecar would coincidentally settle by flush time and SSR its
 * data); only the product loader is flagged. Contract:
 *
 * - Document lane: the flagged loader is awaited before first flush, so the
 *   raw HTML carries its data (its skeleton never SSRs), its Meta push rides
 *   the SSR handle snapshot (the SsrMetaEcho div), and a delayed thrown
 *   notFound() yields a REAL 404 status with NO warm-up — where the unflagged
 *   product route's status is only opportunistic (see
 *   client-shop-signals.test.ts warmDocumentRoute).
 * - Per-loader scoping: the unflagged, slower sidecar still SSRs as its
 *   skeleton and streams in.
 * - Navigation lane: the SAME flagged loader streams behind its Suspense
 *   boundary — the flag narrows where streaming applies, it does not disable
 *   it.
 *
 * The document assertions read the COMPLETE response body. That is still
 * discriminating: streamed-late content arrives as Flight payloads inside
 * script tags (escaped), so the PRESENCE/ABSENCE of skeleton testids in parsed
 * HTML positions, and text adjacent to the echo div's attribute, only come
 * from what the SSR pass actually rendered.
 */

async function fetchDocumentBody(page: Page, url: string) {
  const response = await page.request.get(url);
  return { status: response.status(), body: await response.text() };
}

function expectSsrCompleteDocument(body: string) {
  // Awaited loader: data in the SSR'd HTML, skeleton never rendered.
  expect(body).toContain("Wireless Headphones — $99.99");
  expect(body).not.toContain("client-shop-ssr-awaited-skeleton");
  // The awaited push reaches the SSR'd <head> <title> itself (router Meta →
  // MetaTags; collectMeta title dedup replaces the root default) — the tab
  // title is correct with no JS, not just after TitleUpdater's effect.
  expect(body).toMatch(
    /<title[^>]*>Wireless Headphones — SSR complete<\/title>/,
  );
  expect(body).not.toMatch(/<title[^>]*>RSC Router Demo<\/title>/);
  // Handle push rode the SSR snapshot: the page's SsrMetaEcho div carries the
  // value IN the markup (a late handlesLate push would leave it empty until
  // hydration; the Flight copy of the string sits escaped inside script tags,
  // never adjacent to this attribute).
  expect(body).toContain(
    'data-testid="client-shop-ssr-title">Wireless Headphones — SSR complete<',
  );
  // Unflagged (slower) sibling still streamed: its skeleton IS in the shell
  // (and its data arrives later in the same stream).
  expect(body).toContain("client-shop-ssr-sidecar-skeleton");
  expect(body).toContain("streamed sidecar data");
  // Element-heavy read site (nested divs + <Link>s off the same flagged
  // loader): SSR-completeness must not degrade with subtree complexity —
  // its skeleton never SSRs and the link markup is in the visible document.
  expect(body).not.toContain("client-shop-ssr-complex-skeleton");
  expect(body).toContain("client-shop-ssr-breadcrumbs");
  expect(body).toContain("View product page — $99.99");
  // Consumer-app repro shape (read above the boundary, nested category data
  // through props, bare-string fallback): renders complete, fallback never
  // emitted.
  expect(body).toContain("client-shop-ssr-catbuttons");
  expect(body).toContain("Sub One");
  expect(body).not.toContain("CategoriesButtons");
}

devTest.describe("client-shop loader ssr:false", () => {
  devTest(
    "document load carries the awaited loader's data and title; the sidecar streams",
    async ({ page, devServerURL }) => {
      const { status, body } = await fetchDocumentBody(
        page,
        devURL(devServerURL, "/client-shop/ssr/wireless-headphones"),
      );
      expect(status).toBe(200);
      expectSsrCompleteDocument(body);
    },
  );

  devTest(
    "document load of a missing slug is a real 404 with no warm-up",
    async ({ page, devServerURL }) => {
      const response = await page.goto(
        devURL(devServerURL, "/client-shop/ssr/discontinued-widget"),
      );
      // The loader throws notFound() only AFTER its 400ms delay — without the
      // await this rejection always loses the flush race (status 200). No
      // warmDocumentRoute here: determinism is the contract under test.
      expect(response!.status()).toBe(404);
      await waitForHydration(page);
      await expect(page.locator('[data-testid="app-not-found"]')).toBeVisible({
        timeout: 8000,
      });
    },
  );

  devTest(
    "client navigation still streams the flagged loader behind its boundary",
    async ({ page, devServerURL }) => {
      // Warm the route's modules on another slug first so the skeleton window
      // is bounded by the 400ms loader, not dev compile time. The alt slug
      // keeps the param-sensitive revalidate predicate re-running the loader.
      await page.goto(
        devURL(devServerURL, "/client-shop/ssr/wireless-headphones"),
      );
      await waitForHydration(page);
      await page.click('[data-testid="client-shop-ssr-back"]');
      await page.click('[data-testid="client-shop-ssr-link-alt"]');
      await expect(
        page.locator('[data-testid="client-shop-ssr-awaited-skeleton"]'),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.locator('[data-testid="client-shop-ssr-name"]'),
      ).toContainText("Desk Lamp", { timeout: 10000 });
    },
  );
});

prodDescribe("client-shop loader ssr:false", (f) => {
  test("document load carries the awaited loader's data and title; the sidecar streams", async ({
    page,
  }) => {
    const { status, body } = await fetchDocumentBody(
      page,
      f.url("/client-shop/ssr/wireless-headphones"),
    );
    expect(status).toBe(200);
    expectSsrCompleteDocument(body);
  });

  test("document load of a missing slug is a real 404 with no warm-up", async ({
    page,
  }) => {
    const response = await page.goto(
      f.url("/client-shop/ssr/discontinued-widget"),
    );
    expect(response!.status()).toBe(404);
    await waitForHydration(page);
    await expect(page.locator('[data-testid="app-not-found"]')).toBeVisible({
      timeout: 8000,
    });
  });

  test("client navigation still streams the flagged loader behind its boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/client-shop/ssr/wireless-headphones"));
    await waitForHydration(page);
    await page.click('[data-testid="client-shop-ssr-back"]');
    await page.click('[data-testid="client-shop-ssr-link-alt"]');
    await expect(
      page.locator('[data-testid="client-shop-ssr-awaited-skeleton"]'),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator('[data-testid="client-shop-ssr-name"]'),
    ).toContainText("Desk Lamp", { timeout: 10000 });
  });
});
