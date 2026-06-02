import { expect, test } from "@playwright/test";
import type { Fixture } from "./fixture";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  getNumericContent,
} from "./helper";

/**
 * End-to-end suite for the "mini" app.
 *
 * The mini app is the single-file feasibility experiment: one server file
 * (src/router.tsx) and one client file (src/client.tsx) — plus two small
 * RSC-mandated modules (actions.tsx, shared.tsx) — exercising (nearly) every
 * @rangojs/router feature that fits a single app.
 *
 * Every behaviour is asserted in BOTH dev and production via the shared
 * miniTests() body, registered under a "dev" describe (isolated dev server) and
 * a "(production)" describe (production build + preview), matching the
 * dev/production project split in playwright.config.ts.
 *
 * Stateful counters (counter, cart) use RELATIVE assertions (read-before,
 * +1-after) because the isolated server keeps in-memory state across the
 * serial tests in a describe.
 */

const MINI_ROOT = "./e2e/mini";

function miniTests(f: Fixture) {
  test("home: SSR, global middleware header, loader, breadcrumb", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const resp = await page.goto(f.url("/"));
    await waitForHydration(page);

    // Global middleware tagged the response + the rendered request id.
    expect(resp?.headers()["x-mini-request"]).toMatch(/^req-\d+$/);
    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByTestId("request-id")).toHaveText(/^req-\d+$/);

    // Loader data rendered via useLoader.
    await expect(page.getByTestId("clock-seq")).toHaveText(/^\d+$/);

    // Root layout breadcrumb.
    await expect(page.getByTestId("crumb-0")).toContainText("Home");
  });

  test("links: client-side navigation (no full reload)", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.getByTestId("nav-counter").click();
    await expect(page.getByTestId("counter-page")).toBeVisible();
    expect(page.url()).toContain("/counter");
  });

  test("links: ctx.reverse (server) + href (client) resolve paths", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Server-side ctx.reverse(): named route (+ params) -> path.
    await expect(page.getByTestId("reverse-counter")).toHaveText("/counter");
    await expect(page.getByTestId("reverse-product")).toHaveText("/products/2");
    // Standalone client href() helper.
    await expect(page.getByTestId("static-href")).toHaveText("/counter");
  });

  test("loaders: useRefreshLoaders re-fetches a registered loader", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    const before = await getNumericContent(page.getByTestId("clock-seq"));
    await page.getByTestId("clock-refresh").click();
    await expect
      .poll(() => getNumericContent(page.getByTestId("clock-seq")))
      .toBeGreaterThan(before);
  });

  test("loaders: useFetchLoader loads on demand", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(page.getByTestId("echo-value")).toHaveText("none");
    await page.getByTestId("echo-load").click();
    await expect(page.getByTestId("echo-value")).toHaveText(/^\d+$/);
  });

  test("actions: form action increments + revalidates loader", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    const before = await getNumericContent(page.getByTestId("count-value"));
    await page.getByTestId("increment-button").click();

    // useActionState surfaced the returned value...
    await expect(page.getByTestId("increment-result")).toHaveText(
      String(before + 1),
    );
    // ...and revalidate(ctx.isAction(increment*)) re-ran the loader.
    await expect(page.getByTestId("count-value")).toHaveText(
      String(before + 1),
    );
  });

  test("actions: imperative call (useTransition) + useAction tracking", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    const before = await getNumericContent(page.getByTestId("count-value"));
    await page.getByTestId("increment-imperative").click();
    await expect(page.getByTestId("count-value")).toHaveText(
      String(before + 1),
    );
    // useAction settles back to idle after the action completes.
    await expect(page.getByTestId("action-state")).toHaveText("idle");
  });

  test("params + include + nested breadcrumbs: product detail", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/products/3"));
    await waitForHydration(page);

    await expect(page.getByTestId("products-layout")).toBeVisible();
    await expect(page.getByTestId("product-detail-name")).toHaveText("Gizmo");
    await expect(page.getByTestId("param-id")).toHaveText("3");
    await expect(page.getByTestId("crumb-1")).toContainText("Products");
    await expect(page.getByTestId("crumb-2")).toContainText("Gizmo");
  });

  test("intercept: modal on soft nav from index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/products"));
    await waitForHydration(page);

    await page.getByTestId("product-open-1").click();
    await expect(page.getByTestId("product-modal")).toBeVisible();
    await expect(page.getByTestId("product-modal-name")).toHaveText("Widget");
    expect(page.url()).toContain("/products/1");
  });

  test("intercept: direct visit shows full page, not modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/products/1"));
    await waitForHydration(page);

    await expect(page.getByTestId("product-detail")).toBeVisible();
    await expect(page.getByTestId("product-modal")).toHaveCount(0);
  });

  test("parallel @cart slot: revalidates after addToCart action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/products"));
    await waitForHydration(page);

    const before = await getNumericContent(page.getByTestId("cart-count"));
    await page.getByTestId("add-to-cart-1").click();
    await expect
      .poll(() => getNumericContent(page.getByTestId("cart-count")))
      .toBe(before + 1);
  });

  test("transition(): same-route nav holds the subtree (state survives)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/products/1"));
    await waitForHydration(page);

    // Bump local component state on /products/1.
    await page.getByTestId("detail-counter").click();
    await page.getByTestId("detail-counter").click();
    await expect(page.getByTestId("detail-counter")).toHaveText("count:2");

    // Navigate to a sibling param (NOT intercepted: from /products/1, the
    // when() guard only matches from /products). transition() holds the subtree
    // so the counter instance is not remounted.
    await page.getByTestId("products-link-2").click();
    await expect(page.getByTestId("product-detail-name")).toHaveText("Gadget");
    await expect(page.getByTestId("detail-counter")).toHaveText("count:2");
  });

  test("typed search params: parse + navigate", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/search?q=react&page=2"));
    await waitForHydration(page);

    await expect(page.getByTestId("search-q")).toHaveText("q:react");
    await expect(page.getByTestId("search-page-num")).toHaveText("page:2");
    // page is coerced to a number per the search schema.
    await expect(page.getByTestId("search-page-type")).toHaveText(
      "page-type:number",
    );

    await page.getByTestId("search-go").click();
    await expect(page.getByTestId("search-q")).toHaveText("q:hello");
  });

  test("cache(): segment + use-cache frozen, loader stays fresh", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache"));
    await waitForHydration(page);
    const segment1 = await getNumericContent(page.getByTestId("segment-seq"));
    const useCache1 = await getNumericContent(page.getByTestId("usecache-seq"));
    const fresh1 = await getNumericContent(page.getByTestId("fresh-seq"));

    await page.goto(f.url("/cache"));
    await waitForHydration(page);
    const segment2 = await getNumericContent(page.getByTestId("segment-seq"));
    const useCache2 = await getNumericContent(page.getByTestId("usecache-seq"));
    const fresh2 = await getNumericContent(page.getByTestId("fresh-seq"));

    // Cached render + "use cache: short" value are stable across requests.
    expect(segment2).toBe(segment1);
    expect(useCache2).toBe(useCache1);
    // The loader is a dynamic hole — fresh on every request.
    expect(fresh2).toBeGreaterThan(fresh1);
  });

  test("errorBoundary(): handler throw renders fallback", async ({ page }) => {
    // Suppress the expected page error from the thrown handler error.
    await page.goto(f.url("/errors/boom"));
    await waitForHydration(page);
    await expect(page.getByTestId("error-fallback")).toBeVisible();
  });

  test("notFoundBoundary(): thrown DataNotFoundError renders fallback", async ({
    page,
  }) => {
    await page.goto(f.url("/errors/missing"));
    await waitForHydration(page);
    await expect(page.getByTestId("notfound-fallback")).toBeVisible();
  });

  test("redirect(): handler redirects to target route", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/errors/go"));
    await waitForHydration(page);
    await expect(page.getByTestId("counter-page")).toBeVisible();
    expect(page.url()).toContain("/counter");
  });

  test("global notFound: unmatched URL renders the 404 page", async ({
    page,
  }) => {
    await page.goto(f.url("/does-not-exist"));
    await waitForHydration(page);
    await expect(page.getByTestId("global-notfound")).toBeVisible();
  });

  test("route-level middleware: scoped var only on its subtree", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/secret"));
    await waitForHydration(page);
    await expect(page.getByTestId("route-scope")).toHaveText("secret-scope");
    await expect(page.getByTestId("secret-request-id")).toHaveText(/^req-\d+$/);
  });

  test("location state: action redirect carries flash state", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/state"));
    await waitForHydration(page);
    await expect(page.getByTestId("flash")).toHaveText("no-flash");

    await page.getByTestId("save-flash").click();
    await expect(page.getByTestId("flash")).toHaveText(
      "Saved via server action!",
    );
    expect(page.url()).toContain("/state");
  });

  test("location state: Link state sets a persistent slot", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/state"));
    await waitForHydration(page);
    await expect(page.getByTestId("origin")).toHaveText("no-origin");

    await page.getByTestId("origin-link").click();
    await expect(page.getByTestId("origin")).toHaveText("origin-link");
  });

  test("navigation hooks: pathname, segments, state, imperative push", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hooks"));
    await waitForHydration(page);

    await expect(page.getByTestId("hook-pathname")).toHaveText("/hooks");
    await expect(page.getByTestId("hook-segments")).toHaveText("hooks");
    await expect(page.getByTestId("hook-nav-state")).toHaveText("idle");
    await expect(page.getByTestId("link-status")).toHaveText("idle");

    await page.getByTestId("hook-push").click();
    await expect(page.getByTestId("counter-page")).toBeVisible();
    expect(page.url()).toContain("/counter");
  });

  test("meta: title template applied per route", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);
    await expect(page).toHaveTitle("Counter · Mini");

    await page.getByTestId("nav-home").click();
    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page).toHaveTitle("Home · Mini");
  });

  test("mount-aware hooks: useMount + useHref under include()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/products"));
    await waitForHydration(page);
    await expect(page.getByTestId("mount-value")).toHaveText("/products");
    await expect(page.getByTestId("local-href")).toHaveText("/products/2");
  });

  test("useReverse: mount-aware reverse from the products route module", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/products"));
    await waitForHydration(page);
    // useReverse(productsRoutes) resolves dot-prefixed local names against the
    // per-module gen, auto-prefixing the include() mount "/products".
    await expect(page.getByTestId("reverse-index")).toHaveText("/products");
    await expect(page.getByTestId("reverse-detail")).toHaveText("/products/2");
  });

  test("useReverse: dotted global names via the named-routes gen (root mount)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);
    // GlobalReverse calls useReverse(NamedRoutes) with dot-prefixed GLOBAL names
    // (".home", ".products.detail") against the auto-emitted
    // router.named-routes.gen.ts — no per-module gen. At the root mount the
    // global map's absolute paths pass through unchanged (the mount prefix is
    // empty); off-root this form would double-prefix, which is why the demo is
    // root-only.
    await expect(page.getByTestId("global-reverse-home")).toHaveText("/");
    await expect(page.getByTestId("global-reverse-product")).toHaveText(
      "/products/2",
    );
  });

  test("scroll restoration: ScrollRestoration sets manual mode", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);
    const mode = await page.evaluate(() => window.history.scrollRestoration);
    expect(mode).toBe("manual");
  });
}

// ---------------------------------------------------------------------------
// Dev mode — isolated dev server (spawned by the fixture).
// ---------------------------------------------------------------------------

test.describe("mini", () => {
  test.describe.configure({ mode: "serial" });
  const f = useFixture({ root: MINI_ROOT, mode: "dev", isolatedServer: true });
  miniTests(f);
});

// ---------------------------------------------------------------------------
// Production mode — the fixture builds the mini app and serves the preview.
// The "(production)" title routes this describe to the production project.
// ---------------------------------------------------------------------------

test.describe("mini (production)", () => {
  test.describe.configure({ mode: "serial" });
  const f = useFixture({ root: MINI_ROOT, mode: "build" });
  miniTests(f);
});
