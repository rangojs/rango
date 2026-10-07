import { test } from "@playwright/test";
import {
  expectAdoptedClickIsNeverWorseThanAPlainClick,
  expectBackAndForwardDuringAFillEndOnTheFilledPage,
  expectBackAndForwardKeepTheFilledPage,
  expectCachedRouteUnderHeldFlaggedLayoutUsesItsRecord,
  expectClickDuringThePrefetchAdoptsIt,
  expectClickFromAScrolledPageEndsAtTheTop,
  expectDeferredOutcomeArrivesWithTheFill,
  expectDocumentAwaitsLoaderThatPrefetchSkips,
  expectDoubleClickEndsOnTheLastFill,
  expectEveryAdoptionSendsItsOwnFill,
  expectFailedFillReachesTheNetworkErrorBoundary,
  expectHeldFlaggedLayoutLeavesRoutesToTheirOwnFlags,
  expectLeavingBeforeTheFillAbortsItAndBackRefetches,
  expectNoBoundaryHoldsThePageLeftUntilTheFillReturns,
  expectPendingFillReadsLikeAStreamingNavigation,
  expectPrefetchFromAnotherPageKeepsWhatIsOnScreen,
  expectPrefetchSkipsFlaggedWorkAndClickFillsIt,
  expectSameRouteNavigationIsNeverDeferred,
  expectUnflaggedRouteIsPrefetchedWhole,
  expectUnusableFillReachesTheErrorBoundary,
  PREFETCH_FALSE_PARITY_CASES,
  type PrefetchFalseFixture,
  type PrefetchFalseScrollCase,
} from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError } from "./helper";

// `prefetch: false` on loader() and loading(): a prefetch skips the flagged
// work, the click that adopts it shows the fallback and sends one fill request
// (docs/design/prefetch-false.md). Every case reads the fixture's server-side
// run counters. Fixture: test-app/src/urls/prefetch-false.tsx; bodies:
// tests/shared-e2e/src/prefetch-false.ts.
function prefetchFalseSuite(f: Fixture) {
  test.setTimeout(60_000);
  const fixture = (): PrefetchFalseFixture => ({ url: (path) => f.url(path) });

  test("a flagged loader is skipped by the prefetch and fetched by the click, beside an unflagged one", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture(), {
      name: "loader",
      prefetched: ["loader.price", "loader.handler"],
      // pf-note-loader: the handle push of the handler the prefetch ran is
      // on screen with the click's commit, not with the fill.
      shownWhileMissing: [
        "pf-loader-page",
        "pf-loader-price",
        "pf-note-loader",
      ],
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

  // The unit is the segment that is new to the client. From the hub the
  // section layout is new: a route below it waits with it, whatever the route
  // declares, behind the layout's fallback and in one fill.
  for (const name of ["section-plain", "section-own"]) {
    test(`a route below a flagged layout that is new waits with the layout: ${name}`, async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture(), {
        name,
        deferred: [`${name}.data`, `${name}.handler`, "section.layout"],
        fallback: "pf-section-fallback",
      });
    });
  }

  test("a flagged layout the client holds defers nothing: routes below it follow their own flags", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectHeldFlaggedLayoutLeavesRoutesToTheirOwnFlags(page, fixture());
  });

  test("a prefetch taken on another page keeps what is on screen when it is adopted", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPrefetchFromAnotherPageKeepsWhatIsOnScreen(page, fixture());
  });

  test("a cache() route below a flagged layout the client holds uses its record", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectCachedRouteUnderHeldFlaggedLayoutUsesItsRecord(page, fixture());
  });

  test("a same-route navigation is never deferred: it reads like the route without the flag", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectSameRouteNavigationIsNeverDeferred(page, fixture());
  });

  // The invariant: a click that adopts a prefetch is never worse than the
  // same click with no prefetch at all.
  for (const spec of PREFETCH_FALSE_PARITY_CASES) {
    const where = `${spec.from ?? "hub"} to ${spec.name}${spec.prefetchedOn ? ", prefetched on the hub" : ""}`;
    test(`a click that adopts a prefetch is never worse than a plain click: ${where}`, async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await expectAdoptedClickIsNeverWorseThanAPlainClick(
        page,
        fixture(),
        spec,
      );
    });
  }

  test("useNavigation() reads a pending fill like a navigation that is still streaming", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPendingFillReadsLikeAStreamingNavigation(page, fixture());
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

  // Both orders, forced: the fill before React commits the adoption, and the
  // adoption's fallback before the fill.
  const scrollCases: Array<[string, PrefetchFalseScrollCase]> = [
    [
      "bare, no boundary: the fill lands first",
      { name: "bare", first: "fill" },
    ],
    [
      "loader, from its own page: the fill lands first",
      { name: "loader", first: "fill", samePage: true },
    ],
    [
      "unit, from its own page: the fill lands first",
      { name: "unit", first: "fill", samePage: true },
    ],
    ["loader: the fallback shows first", { name: "loader", first: "fallback" }],
    ["unit: the fallback shows first", { name: "unit", first: "fallback" }],
    [
      "loader: the reader scrolls while the fallback shows, the fill leaves it",
      { name: "loader", first: "fallback", scrollWhileWaiting: true },
    ],
    ["control, no flag", { name: "control", first: "none" }],
  ];
  for (const [title, spec] of scrollCases) {
    test(`a click from a scrolled page ends at the top: ${title}`, async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await expectClickFromAScrolledPageEndsAtTheTop(page, fixture(), spec);
    });
  }

  for (const name of ["loader", "unit", "bare"]) {
    test(`a click while the prefetch is still in flight adopts it: ${name}`, async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await expectClickDuringThePrefetchAdoptsIt(page, fixture(), name);
    });
  }

  test("a double click on one link ends on the last fill", async ({ page }) => {
    using _ = expectNoPageError(page);
    await expectDoubleClickEndsOnTheLastFill(page, fixture());
  });

  test("back and forward during a fill end on the filled page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectBackAndForwardDuringAFillEndOnTheFilledPage(page, fixture());
  });

  test("a fill the network drops reaches the network error boundary", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectFailedFillReachesTheNetworkErrorBoundary(page, fixture());
  });

  test("a fill the client cannot use reaches the error boundary, with no uncaught error", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectUnusableFillReachesTheErrorBoundary(page, fixture());
  });

  test("control: a route with no flag is prefetched whole and the click sends nothing", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectUnflaggedRouteIsPrefetchedWhole(page, fixture());
  });
}

test.describe("prefetch-false", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  prefetchFalseSuite(f);
});

test.describe("prefetch-false (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  prefetchFalseSuite(f);
});
