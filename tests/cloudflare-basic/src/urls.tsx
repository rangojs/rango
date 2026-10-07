import {
  urls,
  updateTag,
  revalidateTag,
  Meta,
  nonce,
  cookies,
  getRequestContext,
  redirect,
  createVar,
  type Handler,
  type HandlerContext,
  type Middleware,
} from "@rangojs/router";
import type { PrerenderResult } from "@rangojs/router/prerender";
import { CFCacheStore, MemorySegmentCacheStore } from "@rangojs/router/cache";
import { Suspense, type ReactNode } from "react";
import { Link, Outlet } from "@rangojs/router/client";
import {
  LateSuspenseReader,
  LateSuspenseWriter,
} from "./components/LateSuspenseReader.js";
import {
  AppVersionPanel,
  LoadMoreList,
  SharedCarriedCount,
} from "./components/LocationStateOptions.js";
import { StreamTest } from "./components/StreamTest.js";
import { NavLayout } from "./components/NavLayout.js";
import { RootLayout } from "./components/SlowRootLayout.js";
import { FeatureLoading } from "./components/FeatureLoading.js";
import { BlogSidebarLoader } from "./loaders/blog.js";
import { CookieOverlayLoader } from "./loaders/cookie-overlay.js";
import { FeatureLoader, FeatureShellLoader } from "./loaders/feature.js";
import { LoadMoreLoader } from "./loaders/location-state.js";
import {
  DepCrumbProductLoader,
  DepCrumbSiblingLoader,
  LoaderCtxItemLoader,
} from "./loaders/loader-cache-dep.js";
import {
  BodyTaggedDepLoader,
  BodyTaggedLoader,
} from "./loaders/loader-cache-tag.js";
import { CachedSessionLoader } from "./loaders/loader-cache-identity.js";
import {
  LoaderKeyCraftedLoader,
  LoaderKeyVictimLoader,
} from "./loaders/loader-cache-key.js";
import { setOverlayCookie } from "./middleware/cookie-overlay.js";
import { apiPatterns } from "./api/urls.js";
import { purgeModeStore, purgeLog, clearPurgeLog } from "./purge-store.js";
import { slowMarkerStore } from "./slow-marker-store.js";
import { RyowLoader } from "./loaders/ryow.js";
import type { AppBindings } from "./env.js";

// Page handlers
import { HomePage } from "./pages/home.js";
import { CacheLabPage } from "./pages/cache-lab.js";
import { CACHE_LAB_TAGS } from "./cache-lab-contract.js";
import { CacheLabPulseLoader } from "./cache-lab-data.js";
import { AboutPage } from "./pages/about.js";
import { LinkExternalOriginPage } from "./pages/link-external-origin.js";
import { ScriptsDemoPage } from "./pages/scripts-demo.js";
import { CounterPage } from "./pages/counter.js";
import { SplitHero } from "./app/routes/split-hero/SplitHero.js";
import { SplitGallery } from "./app/routes/split-gallery/SplitGallery.js";
import {
  ClientPackageResolutionLayout,
  ClientPackageResolutionPage,
} from "./pages/client-package-resolution.js";
import {
  PprShellLayout,
  PprShellPricePage,
  PprShellStreamPage,
  PprShellSettledPage,
  PprTrapChromeLayout,
  PprBareHomePage,
  PprSlotChromeLayout,
  PprSlotHomePage,
  PprBakeSlowLayout,
  PprBakeSlowPage,
  PprExecLayout,
  PprExecBadgeSlot,
  PprExecPage,
  PprStaleReplayPage,
  PprWarningsPage,
  PprNavPinPage,
  PprShortRecordPage,
  PprScopedChromeLayout,
  PprScopedHomePage,
  PprScopedOptOutPage,
  PprTieredPage,
  PprTieredLayout,
  PprTieredNestedPage,
  pprTier,
  copyPprTier,
  PprScopedConditionPage,
  PprInlineActionPage,
  PprPrerenderedArticle,
  PprPrerenderedPassthroughArticle,
  PprPrerenderedEvictArticle,
  PprPrerenderSeqSlot,
} from "./pages/ppr-shell.js";
import { PprShellBadge } from "./components/PprShellBadge.js";
import { pprExecWhen } from "./components/transition-when.js";
import { PprExecMark, ServerPageStamp } from "./location-states.js";
import {
  CfPhgDynamicPage,
  CfPhgHandlerPage,
  CfPhgLoaderPage,
  CfPhgMwLivePage,
  CfPprBasketPage,
} from "./pages/ppr-header-guard.js";
import {
  CfPhgCookieWriterLoader,
  CfPhgHoleLoader,
} from "./loaders/ppr-header-guard.js";
import {
  PprShellPriceLoader,
  PprShellStreamLoader,
  PprInlineActionHoleLoader,
  PprShellSettledLoader,
  PprShellExecLoader,
  pprExecCounters,
  PprPrerenderSeqLoader,
  PprChromeLoader,
  PprBadgeLoader,
  PprBakeSlowLoader,
  PprBakeHoleLoader,
  PprStorefrontLoader,
  pprStorefrontRuns,
  PprNavPinLoader,
  pprNavPinRuns,
  PprRestockLoader,
  PprFlightErrorLoader,
  pprFlightErrorPasses,
} from "./loaders/ppr-shell.js";
import { PprJsxPage } from "./pages/ppr-jsx.js";
import {
  PprPushDeferredPage,
  PprPushLivePage,
  PprPushPinnedPage,
  PprPushPprSettledPage,
  PprPushPreDeferredPage,
  PprPushPreSettledPage,
  PprPushSlowPage,
} from "./pages/ppr-push-ownership.js";
import {
  PprPushDeferredLoader,
  PprPushLiveLoader,
  PPR_PUSH_SLOW_CAPTURE_TIMEOUT_MS,
  PprPushPinnedLoader,
  PprPushSettledLoader,
  PprPushSlowLoader,
  bumpPprPushGeneration,
} from "./loaders/ppr-push-ownership.js";
import { PprLoadMorePage } from "./pages/ppr-load-more.js";
import { PprLoadMorePageLoader } from "./loaders/ppr-load-more.js";
import { PprJsxLoader } from "./loaders/ppr-jsx.js";
import {
  PprDriftLayout,
  PprDriftPricePage,
  PprSharedBakedStampLoader,
  PprSharedLayout,
  PprSharedPage,
  PprSharedStampLoader,
} from "./pages/ppr-drift.js";
import {
  PprLargeLayout,
  PprLargePage,
  PprLargeHolesPage,
  PprLargeHoleLoader,
} from "./pages/ppr-large.js";
import { PprFreshReadsPage } from "./pages/ppr-fresh-reads.js";
import {
  PprSlowMetaLayout,
  PprShortMetaLayout,
} from "./pages/ppr-slow-meta.js";
import { OrphanFetchTest } from "./components/OrphanFetchTest.js";
import { RenderStabilityRoute } from "./pages/render-stability.js";
import { FeatureDetailPage, FeaturesShell } from "./pages/features.js";
import {
  BlogLayout,
  BlogSidebarHandler,
  SidebarSkeleton,
  BlogIndexPage,
  BlogPostPage,
} from "./pages/blog.js";
import {
  ProactiveCacheLayout,
  ProactiveCacheIndexPage,
  ProactiveCacheItemAPage,
  ProactiveCacheItemBPage,
} from "./pages/proactive-cache.js";
import { DocumentCachePage } from "./pages/document-cache.js";
import { DocumentCacheNoCachePage } from "./pages/document-cache-no-cache.js";
import {
  DocumentCacheThemeLivePage,
  DocumentCacheThemePage,
} from "./pages/document-cache-theme.js";
import {
  DocumentCacheRenderErrorPage,
  PprRenderErrorPage,
  RouteCacheRenderErrorPage,
} from "./pages/capture-render-error.js";
import {
  UseCacheNonCacheablePage,
  requestTenantMiddleware,
} from "./pages/use-cache-non-cacheable.js";
import { TaggedDocumentPage } from "./pages/tagged-document.js";
import { StreamedDocumentPage } from "./pages/streamed-document.js";
import { DslTaggedDocumentPage } from "./pages/dsl-tagged-document.js";
import { CachedHandlesPage } from "./pages/cached-handles.js";
import { LoaderCacheDepPage } from "./pages/loader-cache-dep.js";
import { LoaderCacheTagPage } from "./pages/loader-cache-tag.js";
import { RyowActionPage } from "./pages/ryow-action.js";
import { NestedUseCachePage } from "./pages/nested-use-cache.js";
import { controlHeldValue, getHeldValue } from "./use-cache-tags-data.js";
import {
  LoaderCacheIdentityLayout,
  LoaderCacheIdentityPage,
} from "./pages/loader-cache-identity.js";
import { UseCacheDepPage } from "./pages/use-cache-dep.js";
import { LoaderCtxPage } from "./pages/loader-ctx.js";
import { SlowCachePage } from "./pages/slow-cache.js";
import { SwrCtxPage, SwrActionPage } from "./pages/swr-ctx.js";
import { ThemePage } from "./pages/theme.js";
import {
  CfPprThemeClientPage,
  CfPprThemePage,
  CfPprThemeRequestContextPage,
} from "./pages/ppr-theme.js";
import {
  IdentityRawCachedPage,
  IdentityRawCopiesPage,
  IdentityRawError,
  IdentityRawKeyedPage,
  IdentityRawPprControlPage,
  IdentityRawPprPage,
  IdentityRawUseCacheArgPage,
  IdentityRawUseCachePage,
  answerForwarded,
  visitorOf,
} from "./pages/identity-raw.js";
import {
  UcmBindingPage,
  UcmError,
  UcmHandlerFirstPage,
  UcmPlainPage,
  UcmRequestContextPage,
  UcmVisitorLoader,
} from "./pages/use-cache-memo.js";
import { SlowPage1, SlowPage2, FastPage } from "./pages/slow.js";
import {
  InlineIndexPage,
  InlineDocsPage,
  InlinePricingPage,
} from "./pages/inline.js";
import { clientReversePatterns } from "./pages/client-reverse.js";
import { guidesPatterns } from "./pages/guides.js";
import {
  GuidePlainDef,
  GuideSwrDef,
  guidePlainFailKey,
  guidePlainGoneKey,
} from "./pages/guide-plain.js";
import { guideDeclineKey } from "./pages/guides-handler.js";
import { GuidePlainLoader } from "./loaders/guide-plain.js";
import { suspenseDemoPatterns } from "./pages/suspense-demo.js";
import { releasesPatterns } from "./pages/releases.js";
import { staticContentPatterns } from "./pages/static-content-urls.js";
import { ApiDemoPage } from "./pages/api-demo.js";
import { SearchPage } from "./pages/search.js";
import { transformCasesPatterns } from "./pages/transform-cases.js";
import { compositionPatterns } from "./pages/composition.js";
import { buildSkipPatterns } from "./pages/build-skip.js";
import { prerenderCtxPatterns } from "./pages/prerender-ctx.js";
import { handlerFirstPatterns } from "./pages/handler-first.js";
import { parallelNewSlotRevalPatterns } from "./pages/parallel-new-slot-reval.js";
import { createDocsPatterns } from "@shared/docs";
import { docsArticles } from "./docs-content.js";
import {
  LocaleInfoPage,
  ItemDetailPage,
  ProductReviewsPage,
  CatchAllPage,
  FilesWildcardPage,
} from "./pages/trie-routing-test.js";
import {
  ShopProductPage,
  ShopCategoryPage,
  ShopArchivePage,
} from "./pages/suffix-params-test.js";
import { CookieOverlayPage } from "./pages/cookie-overlay.js";
import { buildEnvPatterns } from "./pages/build-env-handler.js";
import { buildEnvDirectPatterns } from "./pages/build-env-direct-handler.js";
import { ActionLocationStatePage } from "./pages/action-location-state.js";
import { renderedBarrierPatterns } from "./pages/rendered-barrier.js";
import { prefetchTransitionPatterns } from "./pages/prefetch-transition.js";
import { zeroLoaderBoundaryPatterns } from "./pages/zero-loader-boundary.js";
import { txWhenPatterns } from "./pages/tx-when.js";
import { interceptWhenShapePatterns } from "./pages/intercept-when-shape.js";
import { authRedirectPatterns } from "./pages/auth-redirect.js";
import { redirectLoopPatterns } from "./pages/redirect-loop.js";
import { deferredHandleNavPatterns } from "./pages/deferred-handle-nav.js";
import { onErrorLog, clearOnErrorLog } from "./error-log.js";
import {
  WarmCachedPage,
  WarmPersonalPage,
  WarmShellPage,
  WarmTrigger,
  bumpWarmGeneration,
} from "./pages/prerender-warm.js";
import mixedClientUrls from "./mixed-client/urls.js";
import pureClientUrls from "./client-urls/urls.js";
import slowClientUrls, { SlowChrome } from "./client-urls/slow.js";
import clientUrlsVarsPatterns from "./client-urls-vars/urls.js";
import clientUrlsSsrSignalsPatterns from "./client-urls-ssr-signals/urls.js";
import { clientUrlsVarsMiddleware } from "./client-urls-vars/shared.js";
import {
  MirrorSessionLoader,
  MirrorBasketLoader,
  MirrorVehicleLoader,
} from "./loaders/chrome-mirror.js";

const docsPatterns = createDocsPatterns({ articles: docsArticles });

// Serialize a PrerenderResult for the e2e: Error instances don't survive
// Response.json, so flatten to the message.
function flattenResult(result: PrerenderResult): unknown {
  return !result.ok && result.error instanceof Error
    ? { ...result, error: result.error.message }
    : result;
}

function prerenderResultJson(result: PrerenderResult): Response {
  return Response.json(flattenResult(result));
}

// On-demand prerender trigger handler. Explicitly typed as Handler so the lazy
// `import("./router.js")` inside it does not force TypeScript to infer this
// module's type from the router (which is built from urlpatterns) — that would
// be a circular type. Returns the PrerenderResult as JSON for the e2e.
// ?remove=1 removes the page instead (prerender.remove()): the live handler
// answers the next request. ?decline=1 / ?decline=0 make the build handler
// decline the slug (ctx.passthrough()) / stop declining it.
const GuidesTrigger: Handler<{ slug: string }> = async (ctx) => {
  const decline = ctx.url.searchParams.get("decline");
  if (decline) {
    const declineKey = guideDeclineKey(ctx.params.slug);
    if (decline === "1") await ctx.env.PRERENDER_KV.put(declineKey, "1");
    else await ctx.env.PRERENDER_KV.delete(declineKey);
    return Response.json({ decline: decline === "1" });
  }
  const { router } = await import("./router.js");
  const prerender = router.prerender({
    env: ctx.env,
    ctx: ctx.executionContext,
  });
  const target = {
    route: "guides.detail",
    params: { slug: ctx.params.slug },
  } as const;
  const result =
    ctx.url.searchParams.get("remove") === "1"
      ? await prerender.remove(target)
      : await prerender(target);
  return prerenderResultJson(result);
};

// Trigger for the PLAIN (non-Passthrough) on-demand route. Ops via query:
//   default             -> plain refresh (always renders)
//   ?onlyIfStale=1      -> cron-sweep opt-in; "already-fresh" when entry fresh
//   ?markStale=<t>      -> KV tag-marker mark-stale (no render)
//   ?remove=1           -> prerender.remove(): the "removed" marker, no render
//   ?gone=1 / ?gone=0   -> delete / restore the slug in the data source, so
//                          the next refresh hits notFound() or renders again
//   ?fail=1 / ?fail=0   -> take the data source down / bring it back, so the
//                          next refresh throws something other than notFound()
//   ?target=<path> (repeated) -> prerender.many(targets): the results as a
//                          JSON array in target order
const GuidePlainTrigger: Handler<{ slug: string }> = async (ctx) => {
  const { router } = await import("./router.js");
  const prerender = router.prerender({
    env: ctx.env,
    ctx: ctx.executionContext,
  });
  const staleTag = ctx.url.searchParams.get("markStale");
  if (staleTag) {
    await prerender.markStale([staleTag]);
    return Response.json({ markedStale: staleTag });
  }
  const gone = ctx.url.searchParams.get("gone");
  if (gone) {
    const goneKey = guidePlainGoneKey(ctx.params.slug);
    if (gone === "1") await ctx.env.PRERENDER_KV.put(goneKey, "1");
    else await ctx.env.PRERENDER_KV.delete(goneKey);
    return Response.json({ gone: gone === "1" });
  }
  const fail = ctx.url.searchParams.get("fail");
  if (fail) {
    const failKey = guidePlainFailKey(ctx.params.slug);
    if (fail === "1") await ctx.env.PRERENDER_KV.put(failKey, "1");
    else await ctx.env.PRERENDER_KV.delete(failKey);
    return Response.json({ fail: fail === "1" });
  }
  const targets = ctx.url.searchParams.getAll("target");
  if (targets.length > 0) {
    return Response.json((await prerender.many(targets)).map(flattenResult));
  }
  const target = {
    route: "guidePlain",
    params: { slug: ctx.params.slug },
  } as const;
  if (ctx.url.searchParams.get("remove") === "1") {
    return prerenderResultJson(await prerender.remove(target));
  }
  const onlyIfStale = ctx.url.searchParams.get("onlyIfStale") === "1";
  const result = await prerender(
    target,
    onlyIfStale ? { onlyIfStale: true } : undefined,
  );
  return prerenderResultJson(result);
};

// Trigger for the SWR on-demand route. Ops via query:
//   default       -> plain refresh of /guide-swr/:slug
//   ?swrlog=1     -> read the KV marker written by the router-level onRevalidate
//   ?swrclear=1   -> delete the marker (isolates re-runs on a reused server)
const GuideSwrTrigger: Handler<{ slug: string }> = async (ctx) => {
  if (ctx.url.searchParams.get("swrlog") === "1") {
    const log = await ctx.env.PRERENDER_KV.get("swr-log:" + ctx.params.slug);
    return Response.json({ log });
  }
  if (ctx.url.searchParams.get("swrclear") === "1") {
    await ctx.env.PRERENDER_KV.delete("swr-log:" + ctx.params.slug);
    return Response.json({ cleared: true });
  }
  const { router } = await import("./router.js");
  const result = await router.prerender({
    env: ctx.env,
    ctx: ctx.executionContext,
  })({ route: "guideSwr", params: { slug: ctx.params.slug } });
  return prerenderResultJson(result);
};

const PersonalizedGuideTrigger: Handler<{ slug: string }> = async (ctx) => {
  const { router } = await import("./router.js");
  const result = await router.prerender({
    env: ctx.env,
    ctx: ctx.executionContext,
  })({
    route: "guides.personalized",
    params: { slug: ctx.params.slug },
  });
  return prerenderResultJson(result);
};

/** Consumer-mirror template layout: server component between the chrome-loader
 *  layout and the clientUrls include, reading params from getRequestContext —
 *  the CategoryTemplate shape from the consumer app. */
function MirrorTemplateLayout(): ReactNode {
  const params: Record<string, string | undefined> = getRequestContext().params;
  if (params.slug === undefined) return <Outlet />;
  return (
    <>
      <Outlet />
    </>
  );
}

// Server Component layout for the mixed clientUrls() example — stays RSC while
// its included pages are client components with local matching.
function ClientUrlsSlowParent(): ReactNode {
  return (
    <section data-testid="cus-parent">
      <SlowChrome />
      <Outlet />
    </section>
  );
}

function LocationStateOptionsShell(): ReactNode {
  return (
    <div>
      <SharedCarriedCount />
      <Outlet />
    </div>
  );
}

function MixedRscLayout(): ReactNode {
  return (
    <section data-testid="mixed-rsc-layout">
      <header>
        <h1>RSC layout with client pages</h1>
        <p>
          The route layout is a Server Component; its pages are client
          components.
        </p>
      </header>
      <Outlet />
    </section>
  );
}

// /nested-key* (issue #970): the tier the page served and a token a HIT
// replays unchanged.
function nestedKeyTier(ctx: { request: Request }): string {
  return ctx.request.headers.get("x-cache-tier") ?? "none";
}

// The pages under the keyed cache() render middleware's copy of the request
// headers (issue #976: a handler read of ctx.request.headers under cache()
// throws); the key() and the keyGenerator read the headers themselves.
const CacheTier = createVar<string>();
const CacheLocale = createVar<string>();

const copyCacheHeaders: Middleware = async (ctx, next) => {
  ctx.set(CacheTier, nestedKeyTier(ctx));
  ctx.set(CacheLocale, crossStoreLocale(ctx));
  return next();
};

function NestedKeyPage(ctx: HandlerContext): ReactNode {
  return (
    <p data-testid="nested-key-render">
      {`${ctx.get(CacheTier)}:${crypto.randomUUID()}`}
    </p>
  );
}

function NestedKeySiblingPage(ctx: HandlerContext): ReactNode {
  return (
    <p data-testid="nested-key-render">
      {`sibling-${ctx.get(CacheTier)}:${crypto.randomUUID()}`}
    </p>
  );
}

// /nested-condition and /nested-tags (issue #974): a token a HIT replays
// unchanged.
function NestedScopePage(): ReactNode {
  return <p data-testid="nested-scope-render">{crypto.randomUUID()}</p>;
}

// /cross-store (issue #974): the outer cache()'s store partitions by locale;
// the inner cache() writes to the app's CFCacheStore.
function crossStoreLocale(ctx: { request: Request }): string {
  return ctx.request.headers.get("x-cache-locale") ?? "none";
}

const crossStoreLocaleStore = new MemorySegmentCacheStore({
  keyGenerator: (ctx, defaultKey) => `${defaultKey}|${crossStoreLocale(ctx)}`,
});

function CrossStorePage(ctx: HandlerContext): ReactNode {
  return (
    <p data-testid="nested-scope-render">
      {`${ctx.get(CacheLocale)}:${crypto.randomUUID()}`}
    </p>
  );
}

// /test/loader-key-* (issue #1009): the loader's value, and the victim
// loader's id and the router's id, which its default key carries.
async function LoaderKeyVictimPage(
  ctx: HandlerContext<{ probe: string }>,
): Promise<ReactNode> {
  const { from, stamp } = await ctx.use(LoaderKeyVictimLoader);
  const { router } = await import("./router.js");
  return (
    <div>
      <p data-testid="nested-scope-render">{`${from}:${stamp}`}</p>
      <p data-testid="loader-key-victim-id">{LoaderKeyVictimLoader.$$id}</p>
      <p data-testid="cache-key-router-id">{router.id}</p>
    </div>
  );
}

async function LoaderKeyCraftedPage(ctx: HandlerContext): Promise<ReactNode> {
  const { from, stamp } = await ctx.use(LoaderKeyCraftedLoader);
  return <p data-testid="nested-scope-render">{`${from}:${stamp}`}</p>;
}

// #992 fixture. The boundary's server content is held until the e2e releases
// its :gate (GET <page>/release), which it does after seeing the root hydrate.
// The held render polls instead of awaiting a promise the release request
// resolves, so only this Map crosses requests. It counts releases, and a
// render waits for one made after it started: the test loads the page twice
// under one gate.
const lateSuspenseReleases = new Map<string, number>();

async function LateSuspenseContent({ gate }: { gate: string }) {
  const releasesAtStart = lateSuspenseReleases.get(gate) ?? 0;
  // Safety timeout: a failed test must not hold the render.
  const deadline = Date.now() + 15_000;
  while (
    (lateSuspenseReleases.get(gate) ?? 0) === releasesAtStart &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return <LateSuspenseReader />;
}

/**
 * Main URL patterns - Django-style routing API
 */
export const urlpatterns = urls(
  ({
    path,
    layout,
    parallel,
    loader,
    loading,
    cache,
    include,
    middleware,
    transition,
    revalidate,
    errorBoundary,
  }) => [
    // API routes (response routes - skip RSC pipeline)
    include("/api", apiPatterns, { name: "api" }),

    // Test utils: read the onError log (non-destructive). Imports from
    // error-log.js (not router.js) so the read uses a static import and avoids
    // the dynamic-import / module-graph race that can return an empty log.
    path.json(
      "/__test/last-error",
      () => (onErrorLog.length > 0 ? [...onErrorLog] : null),
      { name: "testLastError" },
    ),
    // Test utils: body runs of the /ppr-warnings loaders.
    path.json("/__test/ppr-storefront-runs", () => ({ ...pprStorefrontRuns }), {
      name: "testPprStorefrontRuns",
    }),
    // Test utils: body runs of the /ppr-nav-pin loader.
    path.json("/__test/ppr-nav-pin-runs", () => ({ ...pprNavPinRuns }), {
      name: "testPprNavPinRuns",
    }),
    // Test utils: moves the /ppr-push fixture's generation for one ?probe= on.
    path.json(
      "/__test/ppr-push-bump",
      (ctx): { generation: number } => ({
        generation: bumpPprPushGeneration(ctx.searchParams.get("probe") ?? ""),
      }),
      { name: "testPprPushBump" },
    ),
    // router.prerender() warm fixture (e2e/prerender-warm.test.ts): the
    // trigger a test calls, and the bump that moves one ?probe='s generation.
    path("/__test/warm-trigger", WarmTrigger, { name: "testWarmTrigger" }),
    path.json(
      "/__test/warm-bump",
      (ctx): { generation: number } => ({
        generation: bumpWarmGeneration(ctx.searchParams.get("probe") ?? ""),
      }),
      { name: "testWarmBump" },
    ),
    // Test utils: clear the onError log.
    path.json(
      "/__test/clear-error-log",
      () => {
        clearOnErrorLog();
        return { cleared: true };
      },
      { name: "testClearErrorLog" },
    ),

    // On-demand (ISR-style) prerender trigger. Renders the guides.detail build
    // handler requestlessly and stores it in the KV overlay so the next
    // /guides/:slug request is served from the overlay, short-circuiting the
    // Passthrough live handler. Defined as a top-level typed Handler (below) so
    // its lazy `import("./router.js")` does not create a type cycle with the
    // router (which is initialized from these urlpatterns).
    path("/guide-trigger/:slug", GuidesTrigger, { name: "guidesTrigger" }),
    path("/guide-personalized-trigger/:slug", PersonalizedGuideTrigger, {
      name: "guidesPersonalizedTrigger",
    }),
    path("/guide-plain-trigger/:slug", GuidePlainTrigger, {
      name: "guidePlainTrigger",
    }),
    path("/guide-swr-trigger/:slug", GuideSwrTrigger, {
      name: "guideSwrTrigger",
    }),

    // robots.txt (response route)
    path.text(
      "/robots.txt",
      (ctx) => {
        return new Response("User-agent: *\nAllow: /\nDisallow: /api/\n", {
          headers: { "Content-Type": "text/plain" },
        });
      },
      { name: "robots" },
    ),

    // Tag-based invalidation against the real CFCacheStore (KV-backed markers).
    // The tagged route caches a ts; the invalidate route awaits updateTag so the
    // next read is fresh (read-your-own-writes).
    cache({ ttl: 600, tags: ["cf-items"] }, () => [
      path.json("/test/tagged-json", () => ({ ts: Date.now() }), {
        name: "testTaggedJson",
      }),
    ]),
    // Second tagged route under a DIFFERENT tag, to prove cross-tag isolation:
    // invalidating "cf-items" must leave "cf-items-b" entries intact.
    cache({ ttl: 600, tags: ["cf-items-b"] }, () => [
      path.json("/test/tagged-json-b", () => ({ ts: Date.now() }), {
        name: "testTaggedJsonB",
      }),
    ]),
    // Global cache.searchParams key filter (router.tsx excludes utm_*):
    // dedicated route so the collapsed bare-path slot never collides with
    // another suite's cache state. Exercised by search-params-cache-key.test.ts.
    cache({ ttl: 600 }, () => [
      path.json(
        "/test/spk-cached",
        (ctx) => ({
          source: "spk-cached",
          utm: ctx.url.searchParams.get("utm_source") ?? "",
          page: ctx.url.searchParams.get("page") ?? "",
          ts: Date.now(),
        }),
        { name: "testSpkCached" },
      ),
    ]),
    // A key() returning request input as is (issue #975): its result is
    // namespaced, so a header value spelling the victim route's default key
    // (`json:<host>/test/raw-key-victim?probe=...`) can no longer write this
    // route's body under the victim's entry.
    cache(
      { ttl: 600, key: (ctx) => ctx.request.headers.get("x-raw-key") ?? "" },
      () => [
        path.json(
          "/test/raw-key",
          () => ({ from: "raw-key", token: crypto.randomUUID() }),
          { name: "testRawKey" },
        ),
      ],
    ),
    cache({ ttl: 600 }, () => [
      path.json(
        "/test/raw-key-victim",
        () => ({ from: "victim", token: crypto.randomUUID() }),
        { name: "testRawKeyVictim" },
      ),
    ]),
    // A loader's own cache() with a key() returning request input as is
    // (issue #1009): its result is namespaced by the loader, so a header
    // value spelling the victim loader's default key
    // (`loader:<id>:<host>/test/loader-key-victim/<probe>:probe=<probe>`)
    // neither reads nor overwrites the victim's entry.
    path(
      "/test/loader-key-crafted",
      LoaderKeyCraftedPage,
      { name: "testLoaderKeyCrafted" },
      () => [
        loader(LoaderKeyCraftedLoader, () => [
          cache({
            ttl: 600,
            key: (ctx) => ctx.request.headers.get("x-loader-key") ?? "",
          }),
        ]),
      ],
    ),
    path(
      "/test/loader-key-victim/:probe",
      LoaderKeyVictimPage,
      { name: "testLoaderKeyVictim" },
      () => [loader(LoaderKeyVictimLoader, () => [cache({ ttl: 600 })])],
    ),
    // Test fixture only: the tag comes from the URL param so the e2e can
    // exercise arbitrary tags. Never do this in production code - deriving
    // invalidation tags from untrusted input lets an attacker grow the
    // tag-marker namespace without bound (see
    // CFCacheStoreOptions.tagInvalidationTtl).
    path.json(
      "/test/invalidate-tag/:tag",
      async (ctx) => {
        await updateTag(ctx.params.tag);
        return { ok: true, tag: ctx.params.tag };
      },
      { name: "testInvalidateTag" },
    ),
    // revalidateTag: fire-and-forget (background via waitUntil), NOT awaited.
    // Test fixture only: the tag comes from the URL param so the e2e can
    // exercise arbitrary tags. Never do this in production code - deriving
    // invalidation tags from untrusted input lets an attacker grow the
    // tag-marker namespace without bound (see
    // CFCacheStoreOptions.tagInvalidationTtl).
    path.json(
      "/test/revalidate-tag/:tag",
      (ctx) => {
        revalidateTag(ctx.params.tag);
        return { ok: true, tag: ctx.params.tag };
      },
      { name: "testRevalidateTag" },
    ),
    // A "use cache" body held after it read its data, and its controls
    // (use-cache-tags-data.ts): another request changes the data and runs
    // updateTag() while it is held, and its write must not land (#977).
    path.json(
      "/held-use-cache/:probe",
      (ctx) => getHeldValue(ctx.params.probe),
      { name: "heldUseCache" },
    ),
    path.json(
      "/held-use-cache/:probe/:op",
      async (ctx) => {
        const result = await controlHeldValue(ctx.params.probe, ctx.params.op);
        if (result.tag) await updateTag(result.tag);
        return result;
      },
      { name: "heldUseCacheControl" },
    ),

    // Purge mode (tagPurge) against the real CFCacheStore in workerd, on a
    // SEPARATE store so the marker-mode routes above keep their semantics.
    // The tagPurge stub records the Cache-Tags (workerd cannot purge by tag);
    // the e2e asserts the recorded tags and the delegation contract (a
    // surviving L1 entry keeps serving after updateTag). See purge-store.ts.
    cache({ ttl: 600, tags: ["cf-purge-items"], store: purgeModeStore }, () => [
      path.json("/test/purge-tagged-json", () => ({ ts: Date.now() }), {
        name: "testPurgeTaggedJson",
      }),
    ]),
    // Test utils: read / clear the recorded purge calls (same module-state
    // pattern as /__test/last-error).
    path.json("/__test/purge-log", () => ({ calls: [...purgeLog] }), {
      name: "testPurgeLog",
    }),
    path.json(
      "/__test/clear-purge-log",
      () => {
        clearPurgeLog();
        return { cleared: true };
      },
      { name: "testClearPurgeLog" },
    ),

    // Cached response routes: test cache() with CFCacheStore across MIME types
    cache({ ttl: 600 }, () => [
      path.json(
        "/test/cached-json",
        () => ({ source: "cached-json", ts: Date.now() }),
        { name: "testCachedJson" },
      ),
      path.text("/test/cached-text", () => `text:${Date.now()}`, {
        name: "testCachedText",
      }),
      path.xml(
        "/test/cached-xml",
        () => `<root><ts>${Date.now()}</ts></root>`,
        { name: "testCachedXml" },
      ),
      path.html(
        "/test/cached-html",
        () => `<h1 data-ts="${Date.now()}">cached</h1>`,
        { name: "testCachedHtml" },
      ),
      path.json(
        "/test/cached-cookie",
        () => {
          cookies().set("session", "tok", { path: "/" });
          return { source: "cached-cookie", ts: Date.now() };
        },
        { name: "testCachedCookie" },
      ),
      path.json(
        "/test/cached-json-query",
        (ctx) => ({
          source: "cached-json-query",
          q: ctx.url.searchParams.get("q") ?? "",
          ts: Date.now(),
        }),
        { name: "testCachedJsonQuery" },
      ),
    ]),

    // Uncached control route for comparison
    path.json(
      "/test/uncached-json",
      () => ({ source: "uncached-json", ts: Date.now() }),
      { name: "testUncachedJson" },
    ),

    // KV L2 test: read KV directly to verify cache writes land in L2
    path.json(
      "/test/kv-l2-check",
      async (ctx) => {
        const kv = ctx.env.KV;
        // List all keys with cache version prefix to check KV was populated
        const list = await kv.list({ limit: 50 });
        return {
          kvKeyCount: list.keys.length,
          kvKeys: list.keys.map((k: { name: string }) => k.name),
        };
      },
      { name: "testKvL2Check" },
    ),

    // KV L2 test: cached route with unique path for isolated testing
    cache({ ttl: 600 }, () => [
      path.json(
        "/test/kv-cached-json",
        () => ({ source: "kv-cached", ts: Date.now() }),
        { name: "testKvCachedJson" },
      ),
    ]),

    // Content negotiation test routes (same URL, different response types)
    path.json(
      "/test/negotiate",
      (ctx) => ({
        format: "json",
        negotiated: true,
      }),
      { name: "testNegotiateJson" },
    ),
    // data-external SSR/browser agreement (pages/link-external-origin.tsx).
    path("/test/link-external-origin", LinkExternalOriginPage, {
      name: "testLinkExternalOrigin",
    }),
    path("/test/negotiate", () => <div>HTML version</div>, {
      name: "testNegotiate",
    }),

    // Content negotiation: text
    path("/test/negotiate-text", () => <div>Text HTML version</div>, {
      name: "testNegotiateText",
    }),
    path.text("/test/negotiate-text", () => "plain text response", {
      name: "testNegotiateTextApi",
    }),

    // Content negotiation: xml
    path("/test/negotiate-xml", () => <div>XML HTML version</div>, {
      name: "testNegotiateXml",
    }),
    path.xml("/test/negotiate-xml", () => "<item><status>ok</status></item>", {
      name: "testNegotiateXmlApi",
    }),

    // Content negotiation: multiple response types on same path
    path.json("/test/negotiate-multi", () => ({ format: "json" }), {
      name: "testNegotiateMultiJson",
    }),
    path.text("/test/negotiate-multi", () => "plain text", {
      name: "testNegotiateMultiText",
    }),
    path.xml(
      "/test/negotiate-multi",
      () => "<root><format>xml</format></root>",
      { name: "testNegotiateMultiXml" },
    ),
    path("/test/negotiate-multi", () => <div>Multi HTML version</div>, {
      name: "testNegotiateMulti",
    }),

    // Content negotiation: wildcard route
    path.json(
      "/test/negotiate-wild/*",
      (ctx) => ({
        format: "json",
        wildcard: (ctx.params as Record<string, string>)["*"],
      }),
      { name: "testNegotiateWildJson" },
    ),
    path("/test/negotiate-wild/*", () => <div>Wildcard HTML</div>, {
      name: "testNegotiateWild",
    }),

    // MIME type test routes (one per tag, used by e2e tests)
    path.json("/test/mime/json", () => ({ type: "json" }), {
      name: "testMimeJson",
    }),
    path.text("/test/mime/text", () => "hello text", { name: "testMimeText" }),
    path.html("/test/mime/html", () => "<h1>hello html</h1>", {
      name: "testMimeHtml",
    }),
    path.xml("/test/mime/xml", () => "<root><type>xml</type></root>", {
      name: "testMimeXml",
    }),
    path.image(
      "/test/mime/image",
      () => {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          headers: { "Content-Type": "image/png" },
        });
      },
      { name: "testMimeImage" },
    ),
    path.stream(
      "/test/mime/stream",
      () => {
        return new Response("stream data", {
          headers: { "Content-Type": "application/octet-stream" },
        });
      },
      { name: "testMimeStream" },
    ),
    path.any(
      "/test/mime/any",
      () => {
        return new Response("custom", {
          headers: { "Content-Type": "application/x-custom" },
        });
      },
      { name: "testMimeAny" },
    ),
    // Suffix param test routes (e.g. /shop/:productId.html)
    path("/shop/:productId.html", ShopProductPage, { name: "shopProduct" }),
    // Longer overlapping suffix declared AFTER `.html` to exercise the
    // longest-suffix-wins fix: /shop/x.archive.html must match here, not above.
    path("/shop/:slug.archive.html", ShopArchivePage, { name: "shopArchive" }),
    path("/shop/:categoryId", ShopCategoryPage, { name: "shopCategory" }),

    // Trie routing bug test routes (constraint fallback + param name collision)
    path("/:locale(en|fr)/info", LocaleInfoPage, { name: "localeInfo" }),
    path("/item/:itemId/detail", ItemDetailPage, { name: "itemDetail" }),
    path("/item/:productId/reviews", ProductReviewsPage, {
      name: "productReviews",
    }),
    include("/build-env", buildEnvPatterns, { name: "buildEnv" }),
    include("/build-env-direct", buildEnvDirectPatterns, {
      name: "buildEnvDirect",
    }),
    // Prefixed wildcard before the root catch-all: hitting bare "/files" must
    // resolve "/files/*" with an empty splat (C1), not fall to "/*".
    path("/files/*", FilesWildcardPage, { name: "filesWildcard" }),
    path("/*", CatchAllPage, { name: "catchAll" }),

    path.json(
      "/__test/age-ppr-shell",
      async (
        ctx,
      ): Promise<{
        ok: boolean;
        found: boolean;
        segmentKeys?: string[];
      }> => {
        const target = ctx.searchParams.get("target") ?? "";
        const targetUrl = new URL(target, ctx.url);
        const { router } = await import("./router.js");
        const key = `${router.id}@${targetUrl.host}${targetUrl.pathname}${targetUrl.search}:shell`;
        const requestContext = getRequestContext<AppBindings>();
        const store = new CFCacheStore({
          ctx: requestContext.executionContext!,
          kv: requestContext.env.KV,
        });
        const hit = await store.getShell(key);
        if (!hit) return { ok: false, found: false };
        await store.putShell(key, hit.entry, 1, 120);
        return {
          ok: true,
          found: true,
          segmentKeys: hit.entry.snapshot
            ?.filter((record) => record.family === "segment")
            .map((record) => record.key),
        };
      },
      { name: "testAgePprShell" },
    ),

    layout(<RootLayout />, () => [
      // Global navigation layout
      layout(<NavLayout />, () => [
        // Core routes
        path("/", HomePage, { name: "home" }),
        path("/about", AboutPage, { name: "about" }),
        path("/counter", CounterPage, { name: "counter" }),
        // app/-rooted client components (issue #1022): app/routes/<id> splits
        // per route. Nameless so the named-routes gen files stay unchanged.
        path("/app-root/hero", () => <SplitHero />),
        path("/app-root/gallery", () => <SplitGallery />),
        layout(ClientPackageResolutionLayout, () => [
          path("/client-package-resolution", ClientPackageResolutionPage, {
            name: "clientPackageResolution",
          }),
        ]),
        // Mixed example: an ordinary RSC layout wrapping a clientUrls()
        // group mounted through include() — the layout is a Server Component;
        // the pages keep browser-local matching and optimistic presentation.
        layout(<MixedRscLayout />, () => [
          include("/mixed-client-routes", mixedClientUrls, {
            name: "mixedClient",
          }),
        ]),
        // Group behind a 5s middleware: pins optimistic presentation vs the
        // gated canonical request (e2e/client-urls-slow.test.ts). The landing
        // route sits OUTSIDE the middleware so the loader redirect is not
        // gated twice.
        path(
          "/client-urls-slow-landing",
          () => <div data-testid="cus-landing">landed</div>,
          { name: "clientSlowLanding" },
        ),
        layout(<ClientUrlsSlowParent />, () => [
          middleware(async (_ctx, next) => {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            await next();
          }),
          include("/client-urls-slow", slowClientUrls, { name: "clientSlow" }),
        ]),
        // The SAME clientUrls() module mounted through an async include with
        // no server urls() wrapper: `() => import()` resolves to the module's
        // client reference, adapted like the eager mount above.
        include("/mixed-client-async", () => import("./mixed-client/urls.js"), {
          name: "mixedClientAsync",
        }),
        // Pure client group: the whole subtree is clientUrls(), mounted in the
        // SAME canonical urls() tree (no separate router, no worker dispatch).
        layout(<MirrorTemplateLayout />, () => [
          // Consumer-mirror chrome loaders: unflagged, streaming above the
          // group while a route's { ssr: false } loader is awaited.
          loader(MirrorSessionLoader),
          loader(MirrorBasketLoader),
          loader(MirrorVehicleLoader),
          include("/__client-urls", pureClientUrls),
        ]),
        // Route middleware vars (createVar token + string key) reach a group
        // loader on the document and partial lanes; the fetch lane is pinned
        // separately (e2e/client-urls-vars.test.ts).
        middleware(clientUrlsVarsMiddleware, () => [
          include("/client-urls-vars", clientUrlsVarsPatterns),
        ]),
        // { ssr: false } loaders settling with redirect()/notFound() before the
        // document flush (e2e/client-urls-ssr-signals.test.ts).
        include("/client-urls-ssr-signals", clientUrlsSsrSignalsPatterns),
        // Streaming useLoader demo: no-loading() route streams per-loader;
        // /gated contrasts the loading() boundary; /ppr pins live holes.
        include("/suspense-demo", suspenseDemoPatterns, {
          name: "suspenseDemo",
        }),
        // Deployable cache lab: two independently tagged "use cache" values
        // rendered inside a tagged PPR shell with promised Meta. The paired e2e
        // drives its authenticated /api/cache/invalidate endpoint and proves
        // selective item refresh, shell-only recapture, and re-caching.
        path(
          "/cache-lab",
          CacheLabPage,
          {
            name: "cacheLab",
            ppr: {
              ttl: 3600,
              swr: 300,
              tags: [CACHE_LAB_TAGS.shell],
            },
          },
          () => [loader(CacheLabPulseLoader)],
        ),
        // PPR shell caching (docs/design/ppr-shell-resume.md). Opt-in per PAGE
        // ROUTE via the `ppr` path option — serving is integral to the router
        // (no middleware); the shell store is the app CFCacheStore (KV-backed
        // getShell/putShell) from createRouter({ cache }).
        // Shell = PprShellLayout (static text + counter + handle reads, and
        // its handler promise + nested handle push, both baked); STRUCTURAL
        // hole = the price route behind loading() (LoaderBoundary is the
        // Suspense boundary capture postpones at). A loader route without
        // loading() awaits its loader at tree-build and can never produce a
        // shell — the /ppr-shell/no-hole negative below. See
        // pages/ppr-shell.tsx.
        layout(PprShellLayout, () => [
          path(
            "/ppr-shell",
            PprShellPricePage,
            { name: "pprShell", ppr: { ttl: 300, swr: 120 } },
            () => [
              loader(PprShellPriceLoader),
              loading(
                <div data-testid="ppr-price-fallback">Loading price...</div>,
              ),
            ],
          ),
          // Loader-carried promise WITH loading(): the loading() boundary is the
          // hole. On a HIT the resume streams three layers in one body — cached
          // shell, then the outer loader value + the inner Suspense fallback,
          // then the nested-promise inner value + $RC.
          path(
            "/ppr-shell/stream",
            PprShellStreamPage,
            { name: "pprShellStream", ppr: { ttl: 300, swr: 120 } },
            () => [
              loader(PprShellStreamLoader),
              loading(
                <div data-testid="ppr-stream-fallback">Loading stream...</div>,
              ),
            ],
          ),
          // Same loader/component, ppr DECLARED, but NO loading(): the
          // loading-less branch awaits loader data at tree-build, so capture's
          // masked loader pins the tree and the sanity gate refuses —
          // x-rango-shell stays MISS forever. The nested inner promise still
          // streams under axis 1 (no loading() degrades only the caching, never
          // the route).
          path(
            "/ppr-shell/no-hole",
            PprShellStreamPage,
            { name: "pprShellNoHole", ppr: true },
            () => [loader(PprShellStreamLoader)],
          ),
          // Settled-marker regression (storefront PDP #438): bake-lane loader
          // whose nested promise is already resolved at container return —
          // the snapshot pins its value; the HIT overlay must rehydrate a
          // Promise for use().
          path(
            "/ppr-shell/settled",
            PprShellSettledPage,
            { name: "pprShellSettled", ppr: true },
            () => [loader(PprShellSettledLoader)],
          ),
          // NAMELESS ppr route (issue #714): `name` is orthogonal to shell
          // caching — the entry registers under a synthesized $path_* manifest
          // key with the ppr option intact, so it must engage (MISS -> HIT)
          // exactly like the named siblings above. Param mirrors the issue's
          // repro shape. NOT in PPR_WARMUP_HIT_ROUTES: its e2e owns the full
          // MISS -> capture -> HIT round-trip.
          path(
            "/ppr-nameless/:probe",
            PprShellPricePage,
            { ppr: { ttl: 300, swr: 120 } },
            () => [
              loader(PprShellPriceLoader),
              loading(
                <div data-testid="ppr-nameless-fallback">Loading price...</div>,
              ),
            ],
          ),
        ]),
        // Deferred shell material settling in parts (issue #715): see
        // pages/ppr-slow-meta.tsx. The declared 10s budget admits the ~6.5s
        // staged settlement; the short-budget sibling refuses. NOT in
        // PPR_WARMUP_HIT_ROUTES — a ~6.5s capture must never park the shared
        // warmup path; the e2e owns the round-trip.
        layout(PprSlowMetaLayout, () => [
          path(
            "/ppr-slow-meta",
            PprShellPricePage,
            {
              name: "pprSlowMeta",
              ppr: { ttl: 300, swr: 120, captureTimeout: 10000 },
            },
            () => [
              loader(PprShellPriceLoader),
              loading(
                <div data-testid="ppr-slow-meta-fallback">
                  Loading price...
                </div>,
              ),
            ],
          ),
        ]),
        path("/ppr-stale-replay/:id", PprStaleReplayPage, {
          name: "pprStaleReplay",
          ppr: { ttl: 4, swr: 120 },
        }),
        // Issue #986: client-managed paging on a route with
        // transition({ when }). revalidate() false keeps the client's
        // accumulated list on a ?page navigation, whether the live path or a
        // replay HIT serves it, whatever the predicate returns.
        path(
          "/ppr-load-more",
          PprLoadMorePage,
          { name: "pprLoadMore", ppr: { ttl: 300, swr: 120 } },
          () => [
            transition({
              when: ({ from, to }) => from.url.pathname === to.url.pathname,
            }),
            revalidate(({ currentUrl, nextUrl }) =>
              currentUrl.pathname === nextUrl.pathname &&
              nextUrl.searchParams.has("page")
                ? false
                : undefined,
            ),
            loader(PprLoadMorePageLoader, { ssr: false }),
          ],
        ),
        // Issue #888: the ssr:false loader awaits an unflagged loader that
        // pushes a string handle. A fast-path HIT replays the doc record,
        // which must not carry the push (see pages/ppr-shell.tsx).
        path(
          "/ppr-warnings",
          PprWarningsPage,
          { name: "pprWarnings", ppr: { ttl: 300, swr: 120 } },
          () => [loader(PprStorefrontLoader, { ssr: false })],
        ),
        // A promise-free ssr:false loader on an entry with loading(): a
        // client navigation that replays the shell pins it like the
        // document HIT, without running it.
        path(
          "/ppr-nav-pin",
          PprNavPinPage,
          { name: "pprNavPin", ppr: { ttl: 300, swr: 120 } },
          () => [
            loader(PprNavPinLoader, { ssr: false }),
            loading(<div data-testid="ppr-nav-pin-loading">Loading...</div>),
          ],
        ),
        // A shell never outlives its route cache() entry: it expires with
        // this 5 s entry, well inside ppr's own ttl.
        cache({ ttl: 5, swr: 0 }, () => [
          path("/ppr-short-record", PprShortRecordPage, {
            name: "pprShortRecord",
            ppr: true,
          }),
        ]),
        // Issue #941: a tagged shell whose server action runs updateTag(); the
        // action's fresh-reads cookie sends the same user's next requests past
        // the stores' isolate memos (e2e/ppr-fresh-reads.test.ts).
        path("/ppr-fresh-reads", PprFreshReadsPage, {
          name: "pprFreshReads",
          ppr: { ttl: 300, swr: 120 },
        }),
        // Issue #929: the ssr:false loader pushes the string handle itself;
        // the replayed record keeps it and the HIT restores it once.
        path(
          "/ppr-restock",
          PprWarningsPage,
          { name: "pprRestock", ppr: { ttl: 300, swr: 120 } },
          () => [loader(PprRestockLoader, { ssr: false })],
        ),
        // router.prerender() warm fixture (issue #1062;
        // e2e/prerender-warm.test.ts): a ppr route, a route under cache()
        // and a ppr route that reads cookies(), none of them on-demand.
        path("/warm/shell", WarmShellPage, {
          name: "warmShell",
          ppr: { ttl: 300, swr: 120 },
        }),
        cache({ ttl: 300 }, () => [
          path("/warm/cached", WarmCachedPage, { name: "warmCached" }),
        ]),
        path("/warm/personal", WarmPersonalPage, {
          name: "warmPersonal",
          ppr: { ttl: 300, swr: 120 },
        }),
        // Push ownership (issues #1001, #1003; e2e/ppr-push-ownership.test.ts).
        // #1003: the loader runs on every replay; its pin serves the data, so
        // the shell record's copy of its push stands, on a navigation too.
        path(
          "/ppr-push/pinned",
          PprPushPinnedPage,
          { name: "pprPushPinned", ppr: { ttl: 300, swr: 120 } },
          () => [loader(PprPushPinnedLoader, { ssr: false })],
        ),
        // The same loader on an entry whose pins maxSnapshotBytes drops: the
        // loader runs fresh on a HIT, so its run's push replaces the record's.
        path(
          "/ppr-push/capped",
          PprPushPinnedPage,
          {
            name: "pprPushCapped",
            ppr: { ttl: 300, swr: 120, maxSnapshotBytes: 1 },
          },
          () => [loader(PprPushPinnedLoader, { ssr: false })],
        ),
        // #1001: the deferred push reaches a replay from the loader's own
        // cache() entry.
        path(
          "/ppr-push/deferred",
          PprPushDeferredPage,
          { name: "pprPushDeferred", ppr: { ttl: 300, swr: 120 } },
          () => [
            loader(PprPushDeferredLoader, { ssr: false }, () => [
              cache({ ttl: 300 }),
            ]),
          ],
        ),
        // The deferred push settles after ppr.captureTimeout: the record
        // leaves it out, so the capture does not wait for it.
        path(
          "/ppr-push/slow",
          PprPushSlowPage,
          {
            name: "pprPushSlow",
            ppr: {
              ttl: 300,
              swr: 120,
              captureTimeout: PPR_PUSH_SLOW_CAPTURE_TIMEOUT_MS,
            },
          },
          () => [loader(PprPushSlowLoader, { ssr: false })],
        ),
        // #1035: a live loader that pushes after an await, read (data and
        // handle) inside its loading() boundary, which hydrates after the
        // root.
        path(
          "/ppr-push/live",
          PprPushLivePage,
          { name: "pprPushLive", ppr: { ttl: 300, swr: 120 } },
          () => [
            loader(PprPushLiveLoader),
            loading(<p data-testid="push-loading">Loading note...</p>),
          ],
        ),
        // #1057: Prerender + ppr. The prerender store supplies the handler
        // layer, so the shell entry keeps the loader's settled push itself.
        path(
          "/ppr-push/pre-settled",
          PprPushPreSettledPage,
          { name: "pprPushPreSettled", ppr: { ttl: 300, swr: 120 } },
          () => [loader(PprPushSettledLoader, { ssr: false })],
        ),
        // The control: the same loader and view without Prerender.
        path(
          "/ppr-push/ppr-settled",
          PprPushPprSettledPage,
          { name: "pprPushPprSettled", ppr: { ttl: 300, swr: 120 } },
          () => [loader(PprPushSettledLoader, { ssr: false })],
        ),
        // #1057 next to #1054: a promise push on a Prerender + ppr route.
        path(
          "/ppr-push/pre-deferred",
          PprPushPreDeferredPage,
          { name: "pprPushPreDeferred", ppr: { ttl: 300, swr: 120 } },
          () => [loader(PprPushDeferredLoader, { ssr: false })],
        ),
        // Storefront shape: ppr routes under an ancestor cache() scope (the
        // real store-app shape — an app-wide cache() wrapping the tree).
        // Navigation replay COMPOSES with the explicit tier on CFCacheStore:
        // the tier's own hit reports `explicit-cache-hit`; on its miss the
        // shell snapshot's doc record supplies the match (`HIT`). Short ttl
        // keeps the tier's warm window test-controllable.
        cache({ ttl: 30, swr: 604_800 }, () => [
          layout(PprScopedChromeLayout, () => [
            path("/ppr-scoped", PprScopedHomePage, {
              name: "pprScoped",
              ppr: { ttl: 300, swr: 120 },
            }),
          ]),
          // Consumer opt-outs stay absolute on the replay path: cache(false)
          // and a false condition() report `cache-disabled` pre-read.
          cache(false, () => [
            path("/ppr-scoped-optout", PprScopedOptOutPage, {
              name: "pprScopedOptOut",
              ppr: { ttl: 300, swr: 120 },
            }),
          ]),
          cache({ ttl: 30, condition: () => false }, () => [
            path("/ppr-scoped-condition", PprScopedConditionPage, {
              name: "pprScopedCondition",
              ppr: { ttl: 300, swr: 120 },
            }),
          ]),
          // Request-partitioned: the cache() key() partitions the record
          // and the shell by the visitor's tier header; the pages render
          // middleware's copy of it (issue #976).
          middleware(copyPprTier, () => [
            cache({ ttl: 300, key: (ctx) => `tier:${pprTier(ctx)}` }, () => [
              path("/ppr-tiered", PprTieredPage, {
                name: "pprTiered",
                ppr: { ttl: 300, swr: 120 },
              }),
              // The same partition through a cache() nested in the keyed
              // one, without a key() of its own (issue #970): its record,
              // keyed by the tier and its own default key, never names
              // /ppr-tiered's.
              layout(PprTieredLayout, () => [
                cache({ ttl: 300 }, () => [
                  path("/ppr-tiered-nested", PprTieredNestedPage, {
                    name: "pprTieredNested",
                    ppr: { ttl: 300, swr: 120 },
                  }),
                ]),
              ]),
            ]),
          ]),
        ]),
        // Refusal semantics under a too-short budget (issue #715 negative):
        // ~3.5s material against an explicit 1500ms budget — the capture
        // refuses (stays MISS, no partial bake). Short tempo keeps the
        // worker's serialized capture queue clear for the sibling ppr tests;
        // the router test-app's slow-meta-default negative is likewise
        // explicit-budget (the 15s default admits both fixtures' material).
        layout(PprShortMetaLayout, () => [
          path(
            "/ppr-short-meta",
            PprShellPricePage,
            {
              name: "pprShortMeta",
              ppr: { ttl: 300, swr: 120, captureTimeout: 1500 },
            },
            () => [
              loader(PprShellPriceLoader),
              loading(
                <div data-testid="ppr-short-meta-fallback">
                  Loading price...
                </div>,
              ),
            ],
          ),
        ]),
        // ppr header-write guard (issue #713): handler/loader header writes on
        // a ppr route throw deterministically; middleware stays the live
        // header lane. Guard routes carry their own errorBoundary and are only
        // fetched by ppr-header-guard.test.ts. NOT in PPR_WARMUP_HIT_ROUTES:
        // the guard routes never store a shell (they 500), and the mw-live/
        // basket e2es own their MISS -> HIT round-trips.
        layout(
          () => (
            <div>
              <Outlet />
            </div>
          ),
          () => [
            errorBoundary((props) => (
              <div data-testid="cf-phg-error-page">
                <span data-testid="cf-phg-error-message">
                  {props.error.message}
                </span>
              </div>
            )),
            path("/ppr-header-guard", CfPhgHandlerPage, {
              name: "pprHeaderGuardHandler",
              ppr: true,
            }),
            path(
              "/ppr-header-guard/loader",
              CfPhgLoaderPage,
              { name: "pprHeaderGuardLoader", ppr: true },
              () => [loader(CfPhgCookieWriterLoader)],
            ),
            // DYNAMIC RE-PERMIT (#735): ctx.dynamic() opts off the shell and
            // clears the ppr header latch, so the handler header write is
            // re-permitted and rides EVERY request (route is always live).
            path("/ppr-header-guard/dynamic", CfPhgDynamicPage, {
              name: "pprHeaderGuardDynamic",
              ppr: true,
            }),
          ],
        ),
        // POSITIVE CONTROL (issue #713): middleware header + cookie on a ppr
        // route ride MISS and HIT alike. Scoped to this subtree.
        middleware(
          async (ctx, next) => {
            ctx.headers.set("X-CF-PHG-MW", "static-value");
            ctx.headers.set("X-CF-PHG-MW-Req", crypto.randomUUID());
            cookies().set("cf_phg_mw_session", "live-cookie", { path: "/" });
            return next();
          },
          () => [
            path(
              "/ppr-mw-live",
              CfPhgMwLivePage,
              { name: "pprMwLive", ppr: { ttl: 300, swr: 120 } },
              () => [
                loader(CfPhgHoleLoader),
                loading(
                  <div data-testid="cf-phg-mw-live-fallback">Loading...</div>,
                ),
              ],
            ),
          ],
        ),
        // Storefront basket shape (issue #713): the action rotates the basket
        // cookie; the following GET is a shell HIT whose middleware reads the
        // cookie per request and reflects it as a response header — session
        // continuity through action POST -> GET(HIT).
        middleware(
          async (ctx, next) => {
            const basket = cookies().get("basket_count")?.value ?? "0";
            ctx.headers.set("X-CF-Basket-Count", basket);
            return next();
          },
          () => [
            path(
              "/ppr-basket",
              CfPprBasketPage,
              { name: "pprBasket", ppr: { ttl: 300, swr: 120 } },
              () => [
                loader(CfPhgHoleLoader),
                loading(
                  <div data-testid="cf-ppr-basket-fallback">Loading...</div>,
                ),
              ],
            ),
          ],
        ),
        // Shell fast-path execution matrix (docs/design/shell-fast-path.md):
        // middleware + layout + parallel + path + loader counters, asserted
        // layer-by-layer across consecutive HITs on workerd/KV. The middleware
        // is scoped to this subtree so its counter isolates the fixture.
        middleware(
          async (ctx, next) => {
            pprExecCounters.middleware += 1;
            // Rides a partial navigation (a replay HIT included) to the
            // browser, where pprExecWhen reads it from `to.state`.
            ctx.setLocationState([
              PprExecMark({ middleware: pprExecCounters.middleware }),
            ]);
            return next();
          },
          () => [
            layout(PprExecLayout, () => [
              parallel({
                "@pprExecBadge": {
                  handler: PprExecBadgeSlot,
                },
              }),
              path(
                "/ppr-shell/exec-matrix",
                PprExecPage,
                { name: "pprShellExecMatrix", ppr: { ttl: 300, swr: 120 } },
                () => [
                  transition({ when: pprExecWhen }),
                  loader(PprShellExecLoader),
                  loading(
                    <div data-testid="ppr-exec-fallback">
                      Loading exec matrix...
                    </div>,
                  ),
                ],
              ),
            ]),
          ],
        ),
        path(
          "/ppr-shell/inline-action",
          PprInlineActionPage,
          {
            name: "pprShellInlineAction",
            ppr: { ttl: 300, swr: 120 },
          },
          () => [
            loader(PprInlineActionHoleLoader),
            // CONTRACT CHANGE (streaming useLoader): value-slot loaders are
            // live at capture unconditionally — the old bake lane (no
            // loading(); the loader executed at capture and its container
            // baked around the nested hole) can no longer produce this
            // fixture's shell. The route-level loading() is now the page
            // hole the bound action streams through.
            loading(
              <div data-testid="ppr-inline-action-fallback">
                Loading inline action…
              </div>,
            ),
          ],
        ),
        // Prerender + ppr composition (docs/design/shell-fast-path.md):
        // build-time segments are the frozen prelude; the slot-owned loader
        // is the badge-sized streaming hole. See pages/ppr-shell.tsx.
        path(
          "/ppr-shell/prerendered/:slug",
          PprPrerenderedArticle,
          { name: "pprShellPrerendered", ppr: { ttl: 300, swr: 120 } },
          () => [
            parallel({
              "@ppSeq": {
                handler: PprPrerenderSeqSlot,
                use: () => [
                  loader(PprPrerenderSeqLoader),
                  loading(
                    <span data-testid="ppr-pp-seq-fallback">
                      Loading pp seq...
                    </span>,
                  ),
                ],
              },
            }),
          ],
        ),
        // Passthrough + Prerender + ppr (replay gate existence probe): only
        // "baked" bakes; other slugs render live and must keep navigation
        // replay on the real CFCacheStore/KV path.
        path(
          "/ppr-shell/passthrough/:slug",
          PprPrerenderedPassthroughArticle,
          {
            name: "pprShellPassthrough",
            ppr: { ttl: 300, swr: 120 },
          },
          // Retaining the prerendered client boundary is part of this streaming
          // contract. Default Passthrough revalidation replaces it with the live
          // handler and discards its local useActionState result.
          () => [revalidate(({ actionId }) => (actionId ? false : undefined))],
        ),
        // Build-shell eviction fixture (#699): its own route + tag so the
        // eviction e2e's updateTag cannot blast the sibling prerendered
        // entries (baked manifest entries are immutable — eviction is a tag
        // MARKER comparison in the store, not a deletion).
        path(
          "/ppr-shell/prerendered-evict/:slug",
          PprPrerenderedEvictArticle,
          {
            name: "pprShellPrerenderedEvict",
            ppr: { ttl: 300, swr: 120, tags: ["ppr-pp-evict-shell"] },
          },
          () => [
            parallel({
              "@ppSeq": {
                handler: PprPrerenderSeqSlot,
                use: () => [
                  loader(PprPrerenderSeqLoader),
                  loading(
                    <span data-testid="ppr-pp-seq-fallback">
                      Loading pp seq...
                    </span>,
                  ),
                ],
              },
            }),
          ],
        ),
        // LAYOUT-LOADER shapes (the storefront): the layout registers a
        // loader with NO loading() on the LAYOUT — the BAKE lane
        // (docs/design/loader-container-bake.md). PprChromeLoader executes at
        // capture, its container bakes (snapshot-pinned on HITs), and both
        // children HIT; the loader child keeps its price hole on the LIVE
        // lane behind loading(). See pages/ppr-shell.tsx.
        layout(PprTrapChromeLayout, () => [
          loader(PprChromeLoader),
          path(
            "/ppr-shell/layout-loader",
            PprShellPricePage,
            { name: "pprShellLayoutLoader", ppr: true },
            () => [
              loader(PprShellPriceLoader),
              loading(
                <div data-testid="ppr-trap-price-fallback">
                  Loading price...
                </div>,
              ),
            ],
          ),
          // The literal storefront-homepage shape: a BARE ppr route (no
          // loader, no loading(), no use list at all) under the
          // loader-registering layout.
          path("/ppr-shell/layout-loader-bare", PprBareHomePage, {
            name: "pprShellLayoutLoaderBare",
            ppr: true,
          }),
        ]),
        // Pin-first bake lane (loader-cache.ts `if (!recorded.holes)`): see
        // PprBakeSlowLayout. The layout's 600ms hole-free bake loader is
        // snapshot-pinned; on a HIT the payload resolves it from the pin
        // immediately instead of gating on the fresh 600ms run. Child keeps a
        // fast live price hole behind loading() so a real shell captures. NOT in
        // PPR_WARMUP_HIT_ROUTES — a 600ms capture must never park the shared
        // warmup path; its e2e owns the MISS -> HIT round-trip.
        layout(PprBakeSlowLayout, () => [
          loader(PprBakeSlowLoader),
          path(
            "/ppr-shell/bake-slow",
            PprBakeSlowPage,
            { name: "pprBakeSlow", ppr: { ttl: 300, swr: 120 } },
            () => [
              loader(PprBakeHoleLoader),
              loading(
                <div data-testid="ppr-bake-price-fallback">
                  Loading price...
                </div>,
              ),
            ],
          ),
        ]),
        // LIVE-lane alternative (skills/ppr "layout-with-loaders playbook"):
        // the same chrome data owned by a @badge parallel slot with its OWN
        // loading() — a badge-sized GUARANTEED-fresh hole (the bake lane
        // would pin the value for the shell's lifetime). Chrome + static page
        // bake; the route needs no loader or loading() of its own.
        layout(PprSlotChromeLayout, () => [
          parallel({
            "@badge": {
              // The slot handler's own awaited copy (frozen, replayed on every
              // HIT) next to the useLoader read of the same loader (live).
              handler: async (ctx: HandlerContext) => {
                const copy = await ctx.use(PprBadgeLoader);
                return (
                  <>
                    <span data-testid="ppr-badge-copy">
                      {copy.replace("badge-", "slotcopy-")}
                    </span>
                    <PprShellBadge loader={PprBadgeLoader} />
                  </>
                );
              },
              use: () => [
                loader(PprBadgeLoader),
                loading(
                  <span data-testid="ppr-badge-fallback">
                    badge pending...
                  </span>,
                ),
              ],
            },
          }),
          path("/ppr-shell/slot-hole", PprSlotHomePage, {
            name: "pprShellSlotHole",
            ppr: true,
          }),
        ]),
        // Capture-data-snapshot DRIFT route: the shell bakes a value from a
        // short-ttl cache() (getPprDriftStamp, "drift" profile, ttl 2s); the
        // shell's own ttl is 300. After the inner ttl expires, a HIT must still
        // show the CAPTURE-time stamp (seeded from the snapshot) — byte parity
        // with the frozen prelude — while the price loader hole stays live. See
        // docs/design/ppr-shell-resume.md ("the capture data snapshot").
        // Large-shell fixture (issue #941): a ~650 KB prelude and a multi-MB
        // capture snapshot. /ppr-large settles with no holes (postponed null);
        // /ppr-large/holes adds a live loader under an inline <Suspense>.
        layout(PprLargeLayout, () => [
          path("/ppr-large", PprLargePage, {
            name: "pprLarge",
            ppr: { ttl: 300, swr: 120 },
          }),
          path(
            "/ppr-large/holes",
            PprLargeHolesPage,
            { name: "pprLargeHoles", ppr: { ttl: 300, swr: 120 } },
            () => [loader(PprLargeHoleLoader)],
          ),
        ]),
        layout(PprDriftLayout, () => [
          path(
            "/ppr-drift",
            PprDriftPricePage,
            { name: "pprDrift", ppr: { ttl: 300, swr: 120 } },
            () => [
              loader(PprShellPriceLoader),
              loading(
                <div data-testid="ppr-drift-price-fallback">
                  Loading price...
                </div>,
              ),
            ],
          ),
        ]),
        // Shared-key route (issue #941): the shell layout, an ssr: false
        // loader and the live hole read the same "drift" item. The snapshot
        // records no cache read, so after the item expires the hole shows a
        // newer stamp than the shell and the ssr: false loader's pin.
        layout(PprSharedLayout, () => [
          path(
            "/ppr-shared-key",
            PprSharedPage,
            { name: "pprSharedKey", ppr: { ttl: 300, swr: 120 } },
            () => [
              loader(PprSharedBakedStampLoader, { ssr: false }),
              loader(PprSharedStampLoader),
              loading(
                <p data-testid="ppr-shared-hole-fallback">Loading stamp...</p>,
              ),
            ],
          ),
        ]),
        // Per-request nonce via the `nonce` ContextVar TOKEN in route middleware
        // (issue #656). A shell is shared per host+URL, so baking one request's
        // nonce into it would break CSP for every other visitor. A ppr route with
        // an active per-request nonce — provider OR token — must stay on axis 1
        // (no PPR participation, no x-rango-shell header) with a once-per-key
        // worker warning. The commit-point gate reads the token AFTER the route
        // middleware runs; before the fix it saw only the provider-threaded nonce
        // and this route wrongly entered capture, freezing one nonce for all. The
        // layout reads ctx.get(nonce) into the SHELL region (above the loading()
        // hole) so each MISS carries a DISTINCT nonce. Middleware is scoped to THIS
        // subtree, not global, so it gates only this route and leaves the other
        // ppr fixtures capturable.
        middleware(
          async (ctx, next) => {
            ctx.set(nonce, crypto.randomUUID());
            return next();
          },
          () => [
            layout(
              (ctx) => {
                const requestNonce = ctx.get(nonce);
                return (
                  <main data-testid="ppr-nonce-page">
                    <h1 data-testid="ppr-nonce-header">PPR Nonce Demo</h1>
                    <span
                      data-testid="ppr-nonce-value"
                      data-nonce={requestNonce ?? "(none)"}
                    />
                    <Outlet />
                  </main>
                );
              },
              () => [
                path(
                  "/ppr-nonce",
                  PprShellPricePage,
                  { name: "pprNonce", ppr: { ttl: 300, swr: 120 } },
                  () => [
                    loader(PprShellPriceLoader),
                    loading(
                      <div data-testid="ppr-nonce-price-fallback">
                        Loading price...
                      </div>,
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
        // Orphan fetchable loader: loader reachable only via a client import,
        // never registered with loader(), never imported by the worker entry.
        path("/orphan-fetch", () => <OrphanFetchTest />, {
          name: "orphanFetch",
        }),
        path("/render-stability/p/:id", RenderStabilityRoute, {
          name: "renderStability",
        }),
        path("/scripts-demo", ScriptsDemoPage, { name: "scriptsDemo" }),
        path("/api-demo", ApiDemoPage, { name: "apiDemo" }),

        // Search route with typed search params
        path("/search", SearchPage, {
          name: "search",
          search: { q: "string", page: "number?", sort: "string?" },
        }),
        layout(FeaturesShell, () => [
          loader(FeatureShellLoader),
          path(
            "/features/:slug",
            FeatureDetailPage,
            { name: "featuresDetail" },
            // transition() opts this route into same-route stale-while-revalidate:
            // navigating between /features/:slug values holds the current content
            // instead of flashing FeatureLoading. Cross-route navs (home ->
            // feature) still remount and may show the skeleton. FeatureLoader
            // (800ms) streams during that hold so FeatureStatus can report
            // isLoading:true for the held data (e2e/loader-nav-stale.test.ts).
            () => [
              loader(FeatureLoader),
              loading(<FeatureLoading />),
              transition(),
            ],
          ),
        ]),

        // #642 regression guard: a NAME-LESS 3-arg children-fn route
        // (path(pattern, component, () => [...]) with no { name } options).
        // Before the ExtractRoutes widened-name fix, this form let TName infer
        // to the bare `string` constraint, emitting an index signature that
        // collapsed the ENTIRE app route map: this app registers
        // `RegisteredRoutes extends typeof router.routeMap`, so Rango.Path
        // became `never` and every href()/Link.to in the app failed to
        // typecheck. Kept unnamed on purpose; its presence keeps this app's
        // `pnpm typecheck` an end-to-end guard. Reachable by URL only.
        path(
          "/unnamed-children-fn",
          () => (
            <div data-testid="unnamed-children-fn-route">
              unnamed children-fn route works
            </div>
          ),
          () => [loading(<FeatureLoading />)],
        ),

        // Blog routes with sidebar. Deliberately NOT ppr'd: keeping /blog on
        // axis 1 keeps the classic blog-cache suite (sidebar-preserve, index
        // render, document-cache interplay) isolated from any PPR capture
        // interference. The PPR'd twin of this exact shape is /ppr-blog below.
        layout(BlogLayout, () => [
          parallel({ "@sidebar": BlogSidebarHandler }, () => [
            loader(BlogSidebarLoader, () => [cache()]),
            loading(<SidebarSkeleton />),
          ]),

          cache({ ttl: 60, swr: 300 }, () => [
            middleware((ctx, next) => {
              // ctx.header(
              //   "Cache-Control",
              //   "s-maxage=60, stale-while-revalidate=300",
              // );
              return next();
            }),
            path("/blog", BlogIndexPage, {
              name: "blog",
            }),
            path("/blog/:slug", BlogPostPage, {
              name: "blogPost",
            }),
          ]),
        ]),

        // A layout ABOVE a cache() boundary is live: it renders and writes its
        // header on every request, cache HITs included. Only the route inside
        // the boundary replays from the store (issue #906).
        layout(
          (ctx) => {
            const token = crypto.randomUUID();
            ctx.headers.set("x-outer-live-layout", token);
            return (
              <div data-testid="outer-live-layout">
                <p data-testid="outer-live-layout-token">{token}</p>
                <Outlet />
              </div>
            );
          },
          () => [
            cache({ ttl: 60 }, () => [
              path(
                "/outer-live",
                () => (
                  <p data-testid="outer-live-route-token">
                    {crypto.randomUUID()}
                  </p>
                ),
                { name: "outerLive" },
              ),
            ]),
          ],
        ),

        // A cache() nested in a keyed cache() keys its records within the
        // outer key() partition (issue #970): without a key() of its own it
        // composes the tier partition with its own default key, so its two
        // routes keep their own records though the outer key() names no
        // route; with one, the key() results compose. The page renders the
        // tier it served and a token a HIT replays unchanged. The probe gives
        // each test its own entries.
        middleware(copyCacheHeaders, () => [
          cache(
            {
              ttl: 60,
              key: (ctx) =>
                `nested-key:${nestedKeyTier(ctx)}?${ctx.url.searchParams.get("probe") ?? ""}`,
            },
            () => [
              cache({ ttl: 60 }, () => [
                path("/nested-key", NestedKeyPage, { name: "nestedKey" }),
                path("/nested-key-sibling", NestedKeySiblingPage, {
                  name: "nestedKeySibling",
                }),
              ]),
              cache(
                {
                  ttl: 60,
                  key: (ctx) =>
                    `variant:${ctx.url.searchParams.get("variant") ?? "none"}`,
                },
                () => [
                  path("/nested-key-composed", NestedKeyPage, {
                    name: "nestedKeyComposed",
                  }),
                ],
              ),
            ],
          ),
        ]),

        // An outer condition() gates the cache() nested in it (issue #974):
        // a request it refuses (x-cache-bypass: 1) renders live, and neither
        // reads nor writes the inner record.
        cache(
          {
            condition: (ctx) =>
              ctx.request.headers.get("x-cache-bypass") !== "1",
          },
          () => [
            cache({ ttl: 60 }, () => [
              path("/nested-condition", NestedScopePage, {
                name: "nestedCondition",
              }),
            ]),
          ],
        ),

        // The outer cache()'s tags tag the record of the cache() nested in
        // it (issue #974): updateTag() of the outer tag evicts it. The probe
        // gives each test its own tag and record.
        cache(
          {
            tags: (ctx) => [
              `nested-outer:${ctx.url.searchParams.get("probe") ?? ""}`,
            ],
          },
          () => [
            cache({ ttl: 60, tags: ["nested-inner"] }, () => [
              path("/nested-tags", NestedScopePage, { name: "nestedTags" }),
            ]),
          ],
        ),

        // An outer cache({ store }) whose keyGenerator partitions by locale
        // partitions the cache() nested in it on the app store (issue #974):
        // a locale never reads another locale's inner record.
        middleware(copyCacheHeaders, () => [
          cache({ store: crossStoreLocaleStore }, () => [
            cache({ ttl: 60 }, () => [
              path("/cross-store", CrossStorePage, { name: "crossStore" }),
            ]),
          ]),
        ]),

        // A layout after a bare cache() wraps every route of the enclosing
        // layout: live on the route before the cache(), stored in the cache
        // with the route after it (issue #918).
        layout(
          () => (
            <div data-testid="marker-shell">
              <p data-testid="marker-shell-token">{crypto.randomUUID()}</p>
              <Outlet />
            </div>
          ),
          () => [
            path(
              "/marker-before",
              () => (
                <p data-testid="marker-route-token">{crypto.randomUUID()}</p>
              ),
              { name: "markerBefore" },
            ),
            cache({ ttl: 60 }),
            layout(() => (
              <div data-testid="marker-promo">
                <p data-testid="marker-promo-token">{crypto.randomUUID()}</p>
                <Outlet />
              </div>
            )),
            path(
              "/marker-after",
              () => (
                <p data-testid="marker-route-token">{crypto.randomUUID()}</p>
              ),
              { name: "markerAfter" },
            ),
          ],
        ),

        // PPR'd DUPLICATE of the blog: the realistic PPR shape (sidebar
        // parallel, ring-3 cache() segment with a rendered timestamp) under the
        // SAME components/loaders as /blog, but with the `ppr` path option. The
        // capture data snapshot pins the ring-3 content so a HIT hydrates
        // cleanly even after the ttl-60 refresh; /blog itself stays non-ppr so
        // the classic blog-cache suite is isolated from capture interference.
        // See docs/design/ppr-shell-resume.md ("the capture data snapshot").
        layout(BlogLayout, () => [
          parallel({ "@sidebar": BlogSidebarHandler }, () => [
            loader(BlogSidebarLoader, () => [cache()]),
            loading(<SidebarSkeleton />),
          ]),

          cache({ ttl: 60, swr: 300 }, () => [
            path("/ppr-blog", BlogIndexPage, {
              name: "pprBlog",
              ppr: { ttl: 300, swr: 120 },
            }),
            path("/ppr-blog/:slug", BlogPostPage, {
              name: "pprBlogPost",
              ppr: { ttl: 300, swr: 120 },
            }),
          ]),
        ]),

        // Proactive cache routes
        cache({ ttl: 600 }, () => [
          layout(<ProactiveCacheLayout />, () => [
            path("/proactive-cache", ProactiveCacheIndexPage, {
              name: "proactiveCache",
            }),
            path("/proactive-cache/item-a", ProactiveCacheItemAPage, {
              name: "proactiveCacheItemA",
            }),
            path("/proactive-cache/item-b", ProactiveCacheItemBPage, {
              name: "proactiveCacheItemB",
            }),
          ]),
        ]),
        // Document cache route
        path("/document-cache", DocumentCachePage, { name: "documentCache" }),

        // C3: document cache route whose response sets an unqualified
        // `Cache-Control: no-cache`. The document cache must refuse to store it
        // (never a frozen HIT), so the rendered timestamp re-executes every
        // request despite the accompanying s-maxage.
        path("/document-cache-no-cache", DocumentCacheNoCachePage, {
          name: "documentCacheNoCache",
        }),

        // #978: a document-cache entry carries the no-cookie default as
        // initialTheme, whoever stored it; /live sends no s-maxage and keeps
        // each visitor's theme. Unnamed: document-cache-theme.test.ts fetches
        // them by URL, no gen-file entry.
        path("/document-cache-theme", DocumentCacheThemePage),
        path("/document-cache-theme/live", DocumentCacheThemeLivePage),

        // Issue #915: a 200 whose async server component threw after the
        // commit must not be stored by the document cache or the PPR shell
        // capture (pages/capture-render-error.tsx). Unnamed: the e2e navigates
        // by URL, no gen-file entry.
        path("/document-cache-render-error", DocumentCacheRenderErrorPage),
        path("/ppr-render-error", PprRenderErrorPage, {
          ppr: { ttl: 300, swr: 120 },
        }),
        // Issue #909: the route cache must not store a write whose async child
        // threw.
        cache({ ttl: 300 }, () => [
          path("/route-cache-render-error", RouteCacheRenderErrorPage),
        ]),
        // Issue #927: the capture must not store a shell whose bake-lane value
        // failed on the snapshot encode (loaders/ppr-shell.ts).
        path(
          "/ppr-flight-error",
          PprWarningsPage,
          { ppr: { ttl: 300, swr: 120 } },
          () => [loader(PprFlightErrorLoader, { ssr: false })],
        ),
        // Its per-?run= encode pass count (pprFlightErrorPasses).
        path.json("/ppr-flight-error-passes", (ctx) => ({
          passes: pprFlightErrorPasses.get(ctx.searchParams.get("run") ?? ""),
        })),
        // Issue #942 fixture (loaders/ppr-jsx.tsx).
        path("/ppr-jsx", PprJsxPage, { ppr: { ttl: 300, swr: 120 } }, () => [
          loader(PprJsxLoader, { ssr: false }),
        ]),
        // Issue #925: a { cache: false } var read inside "use cache" throws.
        middleware(requestTenantMiddleware, () => [
          path("/use-cache-non-cacheable", UseCacheNonCacheablePage, () => [
            errorBoundary((props) => (
              <p data-testid="use-cache-non-cacheable-error">
                {props.error.message}
              </p>
            )),
          ]),
        ]),

        // Tagged document cache route: the full-page response is document-cached
        // AND tagged (via a "use cache" + cacheTag), so updateTag("doc-page")
        // invalidates the whole-page entry (exercises document-level tag flow).
        path("/tagged-document", TaggedDocumentPage, {
          name: "taggedDocument",
        }),

        // Like /tagged-document, but the cacheTag fires inside a Suspense
        // boundary (resolves during the stream, after handler settlement), so it
        // pins the document tag snapshot to the render-complete (stream-drain)
        // barrier rather than the handler-settlement barrier.
        path("/streamed-document", StreamedDocumentPage, {
          name: "streamedDocument",
        }),

        // Document-cached full page whose tag comes from a route-level
        // cache({ tags }) (the segment-DSL tag path), NOT a runtime cacheTag.
        // The segment write is scheduled via waitUntil, so this pins that the
        // route-level tag reaches the document tag union on the FIRST write and
        // updateTag("dsl-doc-page") invalidates the whole-page entry. Cache-Control
        // is set via middleware in-scope (the blog-route pattern) — a cache()-
        // wrapped component's own ctx.headers.set() does not reach the document
        // response. Unnamed: the e2e navigates by URL, no gen-file entry.
        cache({ ttl: 600, tags: ["dsl-doc-page"] }, () => [
          middleware((ctx, next) => {
            ctx.header(
              "Cache-Control",
              "s-maxage=60, stale-while-revalidate=300",
            );
            return next();
          }),
          path("/dsl-tagged-document", DslTaggedDocumentPage),
        ]),

        // Slow cache route
        cache({ ttl: 60, swr: 300 }, () => [
          path("/slow-cache", SlowCachePage, { name: "slowCache" }),
        ]),

        // SWR + getRequestContext() regression: a "use cache: swr-ctx" function
        // (ttl=2s) that reads getRequestContext().env inside its body. On the
        // stale background revalidation the request-context ALS must be
        // re-established or getRequestContext() throws on workerd and the cached
        // value freezes. See pages/swr-ctx.tsx.
        path("/swr-ctx", SwrCtxPage, { name: "swrCtx" }),

        // foregroundOnAction opt-in: a "use cache: swr-action" function whose
        // profile sets foregroundOnAction:true. A plain navigation keeps SWR, but
        // a server action's revalidation render re-executes a stale entry in the
        // foreground so the action response shows a fresh value.
        path("/swr-action", SwrActionPage, { name: "swrAction" }),

        // Cached-handles regression route: a cache()-wrapped route whose handler
        // pushes a Promise<ReactNode> breadcrumb content that must survive the
        // cache round-trip (see pages/cached-handles.tsx).
        cache({ ttl: 60, swr: 300 }, () => [
          path("/cached-handles", CachedHandlesPage, { name: "cachedHandles" }),
        ]),

        // A cached loader's ctx.use dependency, also read by an uncached
        // sibling loader: its crumb appears once on the MISS and on the HIT,
        // where the sibling's live run replaces the replayed crumb. ssr: false
        // puts every push in the document.
        path(
          "/loader-cache-dep",
          LoaderCacheDepPage,
          { name: "loaderCacheDep" },
          () => [
            loader(DepCrumbProductLoader, { ssr: false }, () => [
              cache({ ttl: 600 }),
            ]),
            loader(DepCrumbSiblingLoader, { ssr: false }),
          ],
        ),

        // A loader with its own cache() and no cache({ tags }) whose body
        // calls cacheTag() and reads a tagging dependency, bound after it so
        // the DSL starts the dependency: the entry stores both tags, so
        // updateTag() of either refreshes the loader's value (#964).
        path(
          "/loader-cache-tag",
          LoaderCacheTagPage,
          { name: "loaderCacheTag" },
          () => [
            loader(BodyTaggedLoader, () => [cache({ ttl: 600 })]),
            loader(BodyTaggedDepLoader),
          ],
        ),

        // A "use cache" function whose only tag comes from the "use cache"
        // function it calls, and a server action that runs updateTag() on
        // that tag: the action's own re-render must miss the outer entry
        // (#980).
        path("/nested-use-cache/:probe", NestedUseCachePage, {
          name: "nestedUseCache",
        }),

        // A cached loader on a store whose KV marker writes land late, and a
        // server action that runs revalidateTag() on its tag: the action's
        // own re-render must re-run the loader (#973).
        path(
          "/ryow-action/:probe",
          RyowActionPage,
          { name: "ryowAction" },
          () => [
            loader(RyowLoader, () => [
              cache({ ttl: 600, store: slowMarkerStore }),
            ]),
          ],
        ),

        // A loader with its own cache() whose body reads cookies() (#972).
        // Without a key() the entry would be shared across users, so the fill
        // fails, also when a parent layout handler ran the loader first
        // (reader-first); with a key() that includes the cookie, one entry per
        // session.
        path(
          "/loader-cache-identity/unkeyed",
          LoaderCacheIdentityPage,
          { name: "loaderCacheIdentityUnkeyed" },
          () => [
            loader(CachedSessionLoader, () => [cache({ ttl: 600 })]),
            errorBoundary((props) => (
              <p data-testid="lci-error">{props.error.message}</p>
            )),
          ],
        ),
        layout(LoaderCacheIdentityLayout, () => [
          path(
            "/loader-cache-identity/reader-first",
            LoaderCacheIdentityPage,
            { name: "loaderCacheIdentityReaderFirst" },
            () => [
              loader(CachedSessionLoader, () => [cache({ ttl: 600 })]),
              errorBoundary((props) => (
                <p data-testid="lci-error">{props.error.message}</p>
              )),
            ],
          ),
        ]),
        path(
          "/loader-cache-identity/keyed",
          LoaderCacheIdentityPage,
          { name: "loaderCacheIdentityKeyed" },
          () => [
            loader(CachedSessionLoader, () => [
              cache({
                ttl: 600,
                key: () =>
                  `lci-session:${cookies().get("lci-session")?.value ?? ""}`,
              }),
            ]),
          ],
        ),

        // A "use cache" function reads the same dependency loader, and the
        // handler reads it live after the call: its crumb appears once on the
        // MISS and on the HIT, where the live run replaces the replayed crumb.
        path("/use-cache-dep", UseCacheDepPage, { name: "useCacheDep" }),

        // A DSL loader passes its own ctx to a "use cache" function that
        // pushes a crumb through it: a HIT replays the crumb once, and another
        // id misses (#940).
        path(
          "/loader-ctx/:id",
          LoaderCtxPage,
          { name: "loaderCtxItem" },
          () => [loader(LoaderCtxItemLoader)],
        ),

        // Theme route
        path("/theme", ThemePage, { name: "theme" }),
        // ctx.theme / getRequestContext().theme on a ppr route refuse the
        // capture (#971); the useTheme() route is the HIT control. Fetched only
        // by ppr-theme.test.ts.
        path("/ppr-theme", CfPprThemePage, { name: "pprTheme", ppr: true }),
        path("/ppr-theme/rc", CfPprThemeRequestContextPage, {
          name: "pprThemeRc",
          ppr: true,
        }),
        path("/ppr-theme/client", CfPprThemeClientPage, {
          name: "pprThemeClient",
          ppr: true,
        }),

        // Raw request-identity reads refuse like cookies() (#976); fetched
        // only by identity-raw-reads.test.ts.
        path("/identity-raw/ppr", IdentityRawPprPage, {
          name: "identityRawPpr",
          ppr: true,
        }),
        path("/identity-raw/ppr-control", IdentityRawPprControlPage, {
          name: "identityRawPprControl",
          ppr: true,
        }),
        cache({ ttl: 300 }, () => [
          path(
            "/identity-raw/cached",
            IdentityRawCachedPage,
            { name: "identityRawCached" },
            () => [errorBoundary(IdentityRawError)],
          ),
        ]),
        middleware(answerForwarded, () => [
          cache({ ttl: 300 }, () => [
            path("/identity-raw/copies", IdentityRawCopiesPage, {
              name: "identityRawCopies",
            }),
          ]),
        ]),
        path(
          "/identity-raw/use-cache",
          IdentityRawUseCachePage,
          { name: "identityRawUseCache" },
          () => [errorBoundary(IdentityRawError)],
        ),
        path("/identity-raw/use-cache-arg", IdentityRawUseCacheArgPage, {
          name: "identityRawUseCacheArg",
        }),
        cache(
          {
            ttl: 300,
            key: (ctx) =>
              `visitor:${visitorOf(ctx)}:${ctx.url.searchParams.get("probe") ?? ""}`,
          },
          () => [
            path("/identity-raw/keyed", IdentityRawKeyedPage, {
              name: "identityRawKeyed",
            }),
          ],
        ),

        // "use cache" refuses a memoized loader value that read cookies()
        // (#1011); fetched only by use-cache-memoized-loader.test.ts.
        path(
          "/use-cache-memo/handler-first",
          UcmHandlerFirstPage,
          { name: "useCacheMemoHandlerFirst" },
          () => [errorBoundary(UcmError)],
        ),
        path(
          "/use-cache-memo/binding",
          UcmBindingPage,
          { name: "useCacheMemoBinding" },
          () => [loader(UcmVisitorLoader), errorBoundary(UcmError)],
        ),
        path(
          "/use-cache-memo/request-context",
          UcmRequestContextPage,
          { name: "useCacheMemoRequestContext" },
          () => [errorBoundary(UcmError)],
        ),
        path(
          "/use-cache-memo/plain",
          UcmPlainPage,
          { name: "useCacheMemoPlain" },
          () => [errorBoundary(UcmError)],
        ),

        // Cookie overlay test route
        path(
          "/cookie-overlay",
          CookieOverlayPage,
          { name: "cookieOverlay" },
          () => [middleware(setOverlayCookie), loader(CookieOverlayLoader)],
        ),

        // #992: a persistent useLocationState reader inside a Suspense
        // boundary that the e2e holds until the root has hydrated, then
        // releases.
        path(
          "/location-state-late-suspense/:gate",
          (ctx) => (
            <div>
              <LateSuspenseWriter />
              <Suspense
                fallback={<div data-testid="late-ls-fallback">loading</div>}
              >
                <LateSuspenseContent gate={ctx.params.gate} />
              </Suspense>
            </div>
          ),
          { name: "locationStateLateSuspense" },
        ),
        path.json(
          "/location-state-late-suspense/:gate/release",
          (ctx) => {
            const releases =
              (lateSuspenseReleases.get(ctx.params.gate) ?? 0) + 1;
            lateSuspenseReleases.set(ctx.params.gate, releases);
            return { releases };
          },
          { name: "locationStateLateSuspenseRelease" },
        ),

        // The two fixtures below share a layout whose reader stays mounted
        // across a navigation between them (#1029).
        layout(<LocationStateOptionsShell />, () => [
          // #994 clearOnReload, #1029: a "load more" list. LoadMoreLoader
          // loads the page the URL names; the earlier pages ride along as
          // location state on the Link. The handler sets state of its own on
          // every request, document loads included.
          path(
            "/location-state-load-more",
            (ctx) => {
              const page = Number(ctx.searchParams.get("page") ?? "1");
              ctx.setLocationState(ServerPageStamp({ page }));
              return <LoadMoreList basePath="/location-state-load-more" />;
            },
            { name: "locationStateLoadMore" },
            () => [loader(LoadMoreLoader)],
          ),

          // #994 app version: readers of a typed slot and of plain state.
          path(
            "/location-state-app-version",
            (ctx) => (
              <AppVersionPanel
                basePath="/location-state-app-version"
                step={ctx.searchParams.get("step") ?? "start"}
              />
            ),
            { name: "locationStateAppVersion" },
          ),
        ]),

        // Action location state test route (non-redirect flow)
        path("/action-location-state", ActionLocationStatePage, {
          name: "actionLocationState",
        }),

        // Soft + document redirect guard fixture (mirrors test-app redirect-guard).
        path(
          "/redirect-guard/go",
          () => (
            <div data-testid="redirect-guard-page">
              <h1 data-testid="redirect-guard-title">Redirect Guard</h1>
            </div>
          ),
          { name: "redirectGuardGo" },
          () => [
            middleware((ctx, next) => {
              const to = ctx.searchParams.get("to");
              if (!to) return next();
              const external = ctx.searchParams.get("ext") === "1";
              return external ? redirect(to, { external: true }) : redirect(to);
            }),
          ],
        ),

        // Slow routes for navigation progress demo
        // /slow/1 uses handler pattern (blocks) - for testing
        // /slow/2 uses component pattern (streams)
        path("/slow/1", SlowPage1, { name: "slow1" }),
        path("/slow/2", () => <SlowPage2 />, { name: "slow2" }),
        path("/slow/fast", FastPage, { name: "fast" }),

        // Streaming repro: INLINE handlers (matching the user's repro form)
        // that return immediately and stream a component-placed <Suspense> via
        // a server promise (no router loading()). The fallback must show on a
        // cold client nav.
        path(
          "/stream-test",
          () => (
            <div data-testid="stream-test-index">
              <p>Stream test index</p>
              <ul>
                <li>
                  <Link to="/stream-test/1">Go to stream-test/1</Link>
                </li>
                <li>
                  <Link to="/stream-test/2">Go to stream-test/2</Link>
                </li>
              </ul>
            </div>
          ),
          { name: "streamTestIndex" },
        ),
        path(
          "/stream-test/:id",
          async (ctx) => {
            const data = new Promise<string>((resolve) =>
              setTimeout(() => resolve("resolved " + ctx.params.id), 3000),
            );

            ctx.use(Meta)(
              data.then((d) => ({
                title: `Test with ID ${ctx.params.id}: ${d}`,
              })),
            );

            return (
              <div data-testid="stream-test-page">
                <p data-testid="stream-test-id">Test with ID {ctx.params.id}</p>
                <ul>
                  <li>
                    <Link to="/stream-test">Back to index</Link>
                  </li>
                  <li>
                    <Link to="/stream-test/1">Go to stream-test/1</Link>
                  </li>
                  <li>
                    <Link to="/stream-test/2">Go to stream-test/2</Link>
                  </li>
                </ul>
                <Suspense
                  fallback={
                    <div data-testid="stream-test-fallback">Loading...</div>
                  }
                >
                  <StreamTest data={data} />
                </Suspense>
              </div>
            );
          },
          { name: "streamTestDetail" },
        ),

        // Inline routes demo
        path("/inline", InlineIndexPage, { name: "inlineIndex" }),
        path("/inline/docs", InlineDocsPage, { name: "inlineDocs" }),
        path("/inline/pricing", InlinePricingPage, { name: "inlinePricing" }),
        // Pre-rendered articles (static content, build-time rendering)
        include("/articles", () => import("./pages/articles.js"), {
          name: "articles",
        }),

        // Client useReverse() coverage on the Cloudflare preset
        include("/cr/:tenantId", clientReversePatterns, { name: "cr" }),

        // Pre-rendered guides with passthrough (known slugs pre-rendered, unknown slugs live)
        include("/guides", guidesPatterns, { name: "guides" }),

        // PLAIN (non-Passthrough) on-demand prerender: unbaked params 404 on a
        // live production request (dev falls through to a live render). The
        // loader stays fresh on overlay hits (loaders are never pre-rendered).
        path(
          "/guide-plain/:slug",
          GuidePlainDef,
          { name: "guidePlain" },
          () => [loader(GuidePlainLoader)],
        ),
        // SWR on-demand fixture (ttl 1): a stale overlay hit serves and
        // schedules the router-level onRevalidate via waitUntil.
        path("/guide-swr/:slug", GuideSwrDef, { name: "guideSwr" }),

        // Pre-rendered releases page (uses node:fs at build time, evicted at deploy)
        include("/releases", releasesPatterns, { name: "releases" }),

        // Static content (Static: layout + index rendered once at build time)
        include("/static-content", staticContentPatterns, {
          name: "staticContent",
        }),

        // Composable docs package (demonstrates include + factory pattern)
        include("/docs", docsPatterns, { name: "docs" }),

        // Transform coverage routes (alias imports + export specifiers)
        include("/transform-cases", transformCasesPatterns, {
          name: "transformCases",
        }),

        // Composition test routes (globally imported helpers)
        include("/composition", compositionPatterns, {
          name: "composition",
        }),

        // Skip test routes (prerender + static skip/error handling)
        include("/build-skip", buildSkipPatterns, { name: "buildSkip" }),
        include("/prerender-ctx", prerenderCtxPatterns, {
          name: "prerenderCtx",
        }),

        // Handler-first execution order test
        include("/handler-first", handlerFirstPatterns, {
          name: "handlerFirst",
        }),

        // Regression: revalidate(() => false) on a route-scoped parallel slot
        // must not blank the slot on the soft nav that first introduces it
        include("/parallel-new-slot-reval", parallelNewSlotRevalPatterns, {
          name: "parallelNewSlotReval",
        }),

        // Rendered barrier: loader reads handle data after ctx.rendered()
        include("/rendered-barrier", renderedBarrierPatterns, {
          name: "renderedBarrier",
        }),

        // Fully-prefetched commit mode: no-flash + client-mount-suspense
        // layout-hold contract (mirrors the router e2e app).
        include("/", prefetchTransitionPatterns, { name: "" }),
        include("/", zeroLoaderBoundaryPatterns, { name: "" }),
        // transition({ when }) conditional-gate coverage (mirrors the router
        // e2e app's /tx-when/:hold/:n).
        include("/", txWhenPatterns, { name: "" }),
        // intercept({ when }) from/to locations (mirrors the router e2e app's
        // intercept-when-shape).
        include("/intercept-when-shape", interceptWhenShapePatterns, {
          name: "interceptWhenShape",
        }),

        // Cookie-gated route-middleware redirect (#1047).
        include("/auth-redirect", authRedirectPatterns, {
          name: "authRedirect",
        }),

        // Two pages that redirect to each other (client hop limit).
        include("/redirect-loop", redirectLoopPatterns, {
          name: "redirectLoop",
        }),

        // Deferred-handle navigation contract + history-cache fixes
        // (#622 follow-ups), exercised through client (soft) navigation under
        // the workerd runtime.
        include("/", deferredHandleNavPatterns, { name: "" }),

        // Prerender manifest introspection for e2e tests
        path.json(
          "/__test/prerender-manifest-entries",
          async (ctx) => {
            const routeName = ctx.searchParams.get("route");
            if (!routeName) return { error: "missing route param" };
            if (!globalThis.__loadPrerenderManifestModule)
              return { available: false, count: 0 };
            const mod = await globalThis.__loadPrerenderManifestModule();
            const keys = Object.keys(mod.default).filter((k) =>
              k.startsWith(routeName + "/"),
            );
            return { available: true, count: keys.length };
          },
          { name: "testPrerenderManifestEntries" },
        ),
      ]),
    ]),
  ],
);
