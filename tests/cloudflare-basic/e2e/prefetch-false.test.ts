import { test } from "@playwright/test";
import {
  expectBackAndForwardKeepTheFilledPage,
  expectDeferredOutcomeArrivesWithTheFill,
  expectDocumentAwaitsLoaderThatPrefetchSkips,
  expectEveryAdoptionSendsItsOwnFill,
  expectLeavingBeforeTheFillAbortsItAndBackRefetches,
  expectNoBoundaryHoldsThePageLeftUntilTheFillReturns,
  expectPrefetchSkipsFlaggedWorkAndClickFillsIt,
  expectUnflaggedRouteIsPrefetchedWhole,
  type PrefetchFalseFixture,
} from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError } from "./helper";

// `prefetch: false` on loader() and loading() on workerd (mirrors
// packages/rangojs-router/e2e/prefetch-false.test.ts; docs/design/
// prefetch-false.md). Fixture: src/pages/prefetch-false.tsx. The run counters
// are module state of the worker, read back through /prefetch-false/__counts.
function prefetchFalseSuite(f: ReturnType<typeof useFixture>) {
  test.setTimeout(60_000);
  const fixture = (): PrefetchFalseFixture => ({ url: (path) => f.url(path) });

  test("a flagged loader is skipped by the prefetch and fetched by the click, beside an unflagged one", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture(), {
      name: "loader",
      prefetched: ["loader.price", "loader.handler"],
      shownWhileMissing: ["pf-loader-page", "pf-loader-price"],
    });
  });

  test("a flagged loading() on a plain route skips the handler and its loader together", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture(), {
      name: "unit",
      deferred: ["unit.data", "unit.handler"],
    });
  });

  test("a flagged loading() on a layout skips the layout and everything below it", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture(), {
      name: "section",
      deferred: ["section.data", "section.handler", "section.layout"],
    });
  });

  test("a slot with its own flagged loading() is skipped while the route beside it renders", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture(), {
      name: "slot",
      deferred: ["slot.data", "slot.side"],
      prefetched: ["slot.handler"],
      shownWhileMissing: ["pf-slot-page"],
    });
  });

  test("a flagged loader with no boundary holds the page being left until the fill returns", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectNoBoundaryHoldsThePageLeftUntilTheFillReturns(page, fixture());
  });

  test("a deferred loader that throws reaches its error boundary when the fill returns", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectDeferredOutcomeArrivesWithTheFill(page, fixture(), {
      name: "throws",
      shows: "pf-throws-error",
    });
  });

  test("a deferred loader that calls notFound() reaches its not-found boundary when the fill returns", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectDeferredOutcomeArrivesWithTheFill(page, fixture(), {
      name: "missing",
      shows: "pf-missing-not-found",
    });
  });

  test("a deferred loader that redirects is followed when the fill returns", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectDeferredOutcomeArrivesWithTheFill(page, fixture(), {
      name: "redirects",
      shows: "pf-control-page",
      landsOn: "control",
    });
  });

  test("a deferred handler's handle push arrives with the fill", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectDeferredOutcomeArrivesWithTheFill(page, fixture(), {
      name: "handle",
      shows: "pf-note-handle",
    });
  });

  test("a cache() route serves its handler as usual and skips only the loader behind the fallback", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture(), {
      name: "cached",
      prefetched: ["cached.handler"],
    });
  });

  test("a Prerender route skips only the loader behind the fallback", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture(), {
      name: "prerendered",
    });
  });

  test("a ppr route skips its flagged live loader", async ({ page }) => {
    using _ = expectNoPageError(page);
    await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture(), {
      name: "ppr",
    });
  });

  test("ssr: false with prefetch: false: the document awaits the loader and a prefetch skips it", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectDocumentAwaitsLoaderThatPrefetchSkips(page, fixture());
  });

  test("back and forward after a fill restore the filled page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectBackAndForwardKeepTheFilledPage(page, fixture());
  });

  test("leaving before the fill returns aborts it, and going back fetches what is missing", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectLeavingBeforeTheFillAbortsItAndBackRefetches(page, fixture());
  });

  test("every click that adopts the prefetch sends its own fill", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectEveryAdoptionSendsItsOwnFill(page, fixture());
  });

  test("control: a route with no flag is prefetched whole and the click sends nothing", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectUnflaggedRouteIsPrefetchedWhole(page, fixture());
  });
}

test.describe("prefetch-false (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  prefetchFalseSuite(f);
});

test.describe("prefetch-false (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  prefetchFalseSuite(f);
});
