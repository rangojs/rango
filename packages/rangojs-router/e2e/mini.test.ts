import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("shell manifest: frozen shell replays handle ids, prices stay live", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/manifest"));
    await waitForHydration(page);
    const shell1 = await getNumericContent(
      page.getByTestId("manifest-shell-seq"),
    );
    // Prices resolve for exactly the ids the shell rendered ("3" is in the
    // price store but not in the shell's catalog, so it never appears).
    await expect(page.getByTestId("manifest-price-1")).toHaveText("$19");
    await expect(page.getByTestId("manifest-price-2")).toHaveText("$29");
    await expect(page.getByTestId("manifest-price-3")).toHaveCount(0);
    const priceSeq1 = Number(
      await page.getByTestId("manifest-price-1").getAttribute("data-seq"),
    );

    await page.goto(f.url("/manifest"));
    await waitForHydration(page);
    const shell2 = await getNumericContent(
      page.getByTestId("manifest-shell-seq"),
    );
    const priceSeq2 = Number(
      await page.getByTestId("manifest-price-1").getAttribute("data-seq"),
    );

    // The shell — and its handle pushes — replayed from cache (handler
    // skipped)...
    expect(shell2).toBe(shell1);
    // ...while the live loader read the REPLAYED ids and priced them fresh.
    expect(priceSeq2).toBeGreaterThan(priceSeq1);
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
    // useReverse(productsRoutes) resolves names against the per-module gen,
    // auto-prefixing the include() mount "/products".
    await expect(page.getByTestId("reverse-index")).toHaveText("/products");
    await expect(page.getByTestId("reverse-detail")).toHaveText("/products/2");
    // the leading dot is optional — non-dotted resolves identically.
    await expect(page.getByTestId("reverse-index-nodot")).toHaveText(
      "/products",
    );
    await expect(page.getByTestId("reverse-detail-nodot")).toHaveText(
      "/products/2",
    );
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

  // -- clientChunks: per-route client splitting (dev + production) -----------
  // /widgets and /charts each render a client component colocated in its own
  // directory (routes/widgets, routes/charts). With `clientChunks: true` (mini's
  // vite config) each ships as a separate client chunk + CSS in production; in
  // dev each module loads on demand. Either way, visiting one route must NOT
  // load the other route's client code or CSS. The resource-name check works in
  // both modes: prod chunk "app-widgets-*.js" and dev module ".../widgets/..."
  // both match /widget/, while /charts loads nothing matching /chart/.

  test("clientChunks: /widgets loads only its own client chunk + CSS", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/widgets"));
    await waitForHydration(page);

    // Rendered and hydrated (interactive).
    await expect(page.getByTestId("widget-a")).toBeVisible();
    // Nested components/Badge.tsx (same filename as the charts route's) renders
    // for this route only.
    await expect(page.getByTestId("badge-widgets")).toBeVisible();
    await expect(page.getByTestId("badge-charts")).toHaveCount(0);
    await page.getByTestId("widget-a-btn").click();
    await expect(page.getByTestId("widget-a-btn")).toHaveText(
      "widget-a count: 1",
    );

    // Route-colocated CSS loaded (outline from widget.css applied).
    const outline = await page
      .getByTestId("widget-a")
      .evaluate((el) => getComputedStyle(el).outlineColor);
    expect(outline).toBe("rgb(102, 51, 153)");

    // No cross-route leakage: nothing from the /charts route was loaded.
    const names = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((e) => e.name),
    );
    expect(names.some((n) => /widget/i.test(n))).toBe(true);
    expect(names.some((n) => /chart/i.test(n))).toBe(false);
  });

  test("clientChunks: /charts loads only its own client chunk + CSS", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/charts"));
    await waitForHydration(page);

    await expect(page.getByTestId("chart-b")).toBeVisible();
    await expect(page.getByTestId("badge-charts")).toBeVisible();
    await expect(page.getByTestId("badge-widgets")).toHaveCount(0);
    await page.getByTestId("chart-b-btn").click();
    await expect(page.getByTestId("chart-b-btn")).toHaveText("chart-b open");

    const outline = await page
      .getByTestId("chart-b")
      .evaluate((el) => getComputedStyle(el).outlineColor);
    expect(outline).toBe("rgb(0, 128, 128)");

    const names = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((e) => e.name),
    );
    expect(names.some((n) => /chart/i.test(n))).toBe(true);
    expect(names.some((n) => /widget/i.test(n))).toBe(false);
  });

  // Prefetch warming (dev + production). /warm ships NONE of /widgets' client
  // code and carries a render-strategy prefetch link to it. Decoding the
  // prefetched RSC eagerly imports /widgets' client chunk, so it is warm before
  // the click and the navigation loads no new JS for it. The /widget/-resource
  // check works in both modes (prod "app-widgets-*.js", dev ".../widgets/..."
  // module), exactly like the chunk-isolation tests above. Mirrors waku #2099.
  test("clientChunks: prefetch warms the route's client chunk before the click", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const widgetJs = async () =>
      (
        await page.evaluate(() =>
          performance.getEntriesByType("resource").map((e) => e.name),
        )
      ).filter((n) => /widget/i.test(n));

    await page.goto(f.url("/warm"));
    await waitForHydration(page);

    // /warm renders none of /widgets — yet the render-strategy prefetch decodes
    // /widgets eagerly, which imports its client chunk. Poll until that resource
    // shows up: it loaded with NO click, NO render — that IS the warming.
    await expect
      .poll(async () => (await widgetJs()).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    // The chunk is warm but not yet rendered (we are still on /warm).
    await expect(page.getByTestId("widget-a")).toHaveCount(0);
    const warmed = new Set(await widgetJs());

    // Navigate. The route renders and hydrates (interactive)...
    await page.getByTestId("warm-to-widgets").click();
    await expect(page.getByTestId("widget-a")).toBeVisible();
    await page.getByTestId("widget-a-btn").click();
    await expect(page.getByTestId("widget-a-btn")).toHaveText(
      "widget-a count: 1",
    );

    // ...but loaded NO new /widgets JS on the click — the chunk was warm.
    const afterClick = await widgetJs();
    expect(afterClick.filter((n) => !warmed.has(n))).toEqual([]);
  });

  // Multi-group CSS co-render (dev + production). /combined renders client
  // components from TWO route groups at once (app-widgets + app-charts). This is
  // the case the single-route tests above do NOT cover: two split stylesheets
  // applied on one page, where <link> precedence actually interacts (the source
  // of upstream ordering concerns, vite-plugin-react#1100). Both outlines must
  // apply with the correct cascade and remain stable across a reload (a
  // first-request ordering bug would surface as a dropped/swapped rule).
  test("clientChunks: /combined applies BOTH route groups' CSS, deterministically", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/combined"));
    await waitForHydration(page);

    // Both route groups rendered + hydrated on one page.
    await expect(page.getByTestId("widget-a")).toBeVisible();
    await expect(page.getByTestId("chart-b")).toBeVisible();
    // Same-named nested components/Badge.tsx from each route both render with no
    // collision, even when co-rendered (the groups stay distinct).
    await expect(page.getByTestId("badge-widgets")).toBeVisible();
    await expect(page.getByTestId("badge-charts")).toBeVisible();
    await page.getByTestId("widget-a-btn").click();
    await expect(page.getByTestId("widget-a-btn")).toHaveText(
      "widget-a count: 1",
    );
    await page.getByTestId("chart-b-btn").click();
    await expect(page.getByTestId("chart-b-btn")).toHaveText("chart-b open");

    // Both split stylesheets applied with the correct cascade (no FOUC, no rule
    // clobbering the other). Reading both computed outlines is the universal
    // proof across dev and production regardless of how CSS is injected.
    const outlines = async () => ({
      widget: await page
        .getByTestId("widget-a")
        .evaluate((el) => getComputedStyle(el).outlineColor),
      chart: await page
        .getByTestId("chart-b")
        .evaluate((el) => getComputedStyle(el).outlineColor),
    });
    expect(await outlines()).toEqual({
      widget: "rgb(102, 51, 153)",
      chart: "rgb(0, 128, 128)",
    });

    // Both route groups' resources loaded (the inverse of the leakage checks).
    const names = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((e) => e.name),
    );
    expect(names.some((n) => /widget/i.test(n))).toBe(true);
    expect(names.some((n) => /chart/i.test(n))).toBe(true);

    // Deterministic across requests: a fresh load must apply both rules again.
    // (Targets first-request CSS-order non-determinism — both must survive.)
    await page.goto(f.url("/combined"));
    await waitForHydration(page);
    expect(await outlines()).toEqual({
      widget: "rgb(102, 51, 153)",
      chart: "rgb(0, 128, 128)",
    });
  });

  // clientChunks: registered "use client" error fallback (dev + production).
  // The fallback is pulled into its own app-fallback chunk and is NOT fetched on
  // the happy path; it renders (and hydrates) only when an error is caught.
  test("clientChunks: error fallback is off the happy path, renders on error", async ({
    page,
  }) => {
    // Happy route: the fallback's client code must not be fetched.
    await page.goto(f.url("/widgets"));
    await waitForHydration(page);
    const happyResources = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((e) => e.name),
    );
    expect(
      happyResources.some((n) => /fallback|ClientErrorFallback/i.test(n)),
      "fallback chunk must not load on a happy route",
    ).toBe(false);

    // Error route: the boundary catches the throw and renders the client fallback.
    await page.goto(f.url("/errors/client-boom"));
    await waitForHydration(page);
    await expect(page.getByTestId("client-error-fallback")).toBeVisible();
    // Hydrated/interactive (its chunk loaded and ran).
    await page.getByTestId("client-error-ack").click();
    await expect(page.getByTestId("client-error-fallback")).toContainText(
      "acknowledged",
    );
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

  // Build-graph contract for `clientChunks: true`: route-colocated client
  // components split into per-route JS chunks AND per-route CSS, while the
  // React + router runtime stay in their own shared chunks (not duplicated into
  // the app chunks). The production fixture above builds mini/dist before this
  // runs. See packages/rangojs-router/docs/client-chunking.md.
  test("clientChunks (production): per-route chunks + CSS, shared runtime", async () => {
    const assetsDir = join(
      import.meta.dirname,
      "mini",
      "dist",
      "client",
      "assets",
    );
    const files = readdirSync(assetsDir);
    const js = files.filter((name) => name.endsWith(".js"));
    const css = files.filter((name) => name.endsWith(".css"));

    const widgetsJs = js.find((name) => /^app-widgets-.*\.js$/.test(name));
    const chartsJs = js.find((name) => /^app-charts-.*\.js$/.test(name));
    expect(widgetsJs, "expected an app-widgets-*.js chunk").toBeTruthy();
    expect(chartsJs, "expected an app-charts-*.js chunk").toBeTruthy();
    expect(widgetsJs).not.toBe(chartsJs);

    // Each route chunk holds only its own component's code.
    const widgetsCode = readFileSync(join(assetsDir, widgetsJs!), "utf8");
    const chartsCode = readFileSync(join(assetsDir, chartsJs!), "utf8");
    expect(widgetsCode).toContain("mini-widget-a");
    expect(widgetsCode).not.toContain("mini-chart-b");
    expect(chartsCode).toContain("mini-chart-b");
    expect(chartsCode).not.toContain("mini-widget-a");

    // Collision guard: each route has a same-named nested
    // components/Badge.tsx. The built-in strategy keys on the route id, so they
    // split per route (app-widgets / app-charts) instead of merging into one
    // app-components chunk. No chunk may contain BOTH badges.
    expect(widgetsCode).toContain("badge-widgets");
    expect(widgetsCode).not.toContain("badge-charts");
    expect(chartsCode).toContain("badge-charts");
    expect(chartsCode).not.toContain("badge-widgets");
    const collided = js.filter((name) => {
      const code = readFileSync(join(assetsDir, name), "utf8");
      return code.includes("badge-widgets") && code.includes("badge-charts");
    });
    expect(collided, "no chunk should hold both routes' badges").toEqual([]);

    // CSS splits at the same granularity as JS.
    const widgetsCss = css.find((name) => /^app-widgets-.*\.css$/.test(name));
    const chartsCss = css.find((name) => /^app-charts-.*\.css$/.test(name));
    expect(widgetsCss, "expected an app-widgets-*.css").toBeTruthy();
    expect(chartsCss, "expected an app-charts-*.css").toBeTruthy();
    expect(readFileSync(join(assetsDir, widgetsCss!), "utf8")).toContain(
      "mini-widget-a",
    );
    expect(readFileSync(join(assetsDir, chartsCss!), "utf8")).toContain(
      "mini-chart-b",
    );

    // Shared runtime lives in its own chunks, not duplicated into app chunks.
    expect(js.some((name) => /^react-.*\.js$/.test(name))).toBe(true);
    expect(js.some((name) => /^router-.*\.js$/.test(name))).toBe(true);
    expect(widgetsCode).not.toContain("createRoot");

    // Registered "use client" fallbacks -> dedicated app-fallback chunk, via BOTH
    // registration paths: the route-tree errorBoundary() helper (mini-client-error)
    // AND a router-level createRouter({ defaultErrorBoundary }) (mini-default-error,
    // which never lands in EntryData). Each marker must appear ONLY in app-fallback
    // so the error UI is decoupled from the code it catches failures for.
    const fallbackJs = js.find((name) => /^app-fallback-.*\.js$/.test(name));
    expect(fallbackJs, "expected an app-fallback-*.js chunk").toBeTruthy();
    const fallbackCode = readFileSync(join(assetsDir, fallbackJs!), "utf8");
    for (const marker of ["mini-client-error", "mini-default-error"]) {
      expect(fallbackCode, `${marker} must be in app-fallback`).toContain(
        marker,
      );
      const leaks = js.filter(
        (name) =>
          name !== fallbackJs &&
          readFileSync(join(assetsDir, name), "utf8").includes(marker),
      );
      expect(leaks, `${marker} must live ONLY in app-fallback`).toEqual([]);
    }
    expect(widgetsCode).not.toContain("mini-client-error");
  });
});
