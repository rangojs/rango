import {
  urls,
  Prerender,
  Static,
  createLoader,
  getRequestContext,
  Breadcrumbs,
  type Middleware,
} from "@rangojs/router";
import { Suspense } from "react";
import { ParallelOutlet } from "@rangojs/router/client";
import { ChangelogPage } from "./prerender-fs.js";
import { PrerenderTestLoader } from "../loaders.js";
import { PrerenderClientTest } from "../components/PrerenderClientTest.js";
import { PrerenderPprSeq } from "../components/PrerenderPprSeq.js";
// Resolved by the `test-parity-alias` resolveId plugin (vite.config.ts), not
// resolve.alias. Reaching this through build-time Static/Prerender handlers
// asserts discovery's runner honors third-party resolvers (issue #500).
import { PARITY_MARKER } from "@parity/marker.js";
// Resolved ONLY by Vite 8's native resolve.tsconfigPaths (tsconfig "@native/*"),
// with no resolve.alias and no resolveId plugin. Reaching this through the same
// handlers asserts discovery's runner forwards the native tsconfigPaths flag.
import { NATIVE_PATHS_MARKER } from "@native/marker.js";

// Static handler on a non-parameterized route -- should be pre-rendered at build time.
export const StaticPage = Static((ctx) => {
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Static Page", href: "/static-page" });

  return (
    <div data-testid="static-page">
      <h1 data-testid="static-page-title">Static Page</h1>
      <p data-testid="static-page-content">
        This is a statically pre-rendered page.
      </p>
      <p data-testid="static-page-parity">{PARITY_MARKER}</p>
      <p data-testid="static-page-native">{NATIVE_PATHS_MARKER}</p>
      <p data-testid="static-page-timestamp">Built at: {Date.now()}</p>
    </div>
  );
});

// Static handler on a parameterized route -- test whether the same static
// content is served regardless of the :tag param value.
export const StaticShell = Static<{ tag: string }>(() => {
  return (
    <div data-testid="static-shell">
      <h1 data-testid="static-shell-title">Static Shell</h1>
      <p data-testid="static-shell-content">
        This content is the same for every param.
      </p>
    </div>
  );
});

// Static page -- no params, renders on-demand in dev mode
export const DocsPage = Prerender(async (ctx) => {
  return (
    <div data-testid="docs-page">
      <h1 data-testid="docs-title">Documentation</h1>
      <p data-testid="docs-content">
        This is pre-rendered documentation content.
      </p>
      <p data-testid="docs-parity">{PARITY_MARKER}</p>
      <p data-testid="docs-native">{NATIVE_PATHS_MARKER}</p>
      <p data-testid="docs-pathname">Pathname: {ctx.pathname}</p>
    </div>
  );
});

// Dynamic page -- with params, includes client component with loader/action/locationState
export const DocsArticle = Prerender(
  async () => [{ slug: "getting-started" }, { slug: "api-reference" }],
  async (ctx) => {
    return (
      <div data-testid="docs-article">
        <h1 data-testid="docs-article-title">{ctx.params.slug}</h1>
        <p data-testid="docs-article-content">Content for {ctx.params.slug}</p>
        <PrerenderClientTest loader={PrerenderTestLoader} />
      </div>
    );
  },
);

// Prerender handler that uses ctx.reverse() to generate URLs at build time
export const PrerenderWithReverse = Prerender(async (ctx) => {
  const blogUrl = ctx.reverse("blog.index");
  // Also test getRequestContext().reverse() during prerender
  const reqCtx = getRequestContext()!;
  const hrefUrl = reqCtx.reverse("href.index");
  return (
    <div data-testid="prerender-reverse-page">
      <h1 data-testid="prerender-reverse-title">Prerender Reverse</h1>
      <p data-testid="prerender-reverse-blog">{blogUrl}</p>
      <p data-testid="prerender-reverse-href">{hrefUrl}</p>
    </div>
  );
});

// Static handler that uses getRequestContext().reverse()
export const StaticWithReverse = Static((ctx) => {
  const blogUrl = ctx.reverse("blog.index");
  const reqCtx = getRequestContext()!;
  const hrefUrl = reqCtx.reverse("href.index");
  return (
    <div data-testid="static-reverse-page">
      <h1 data-testid="static-reverse-title">Static Reverse</h1>
      <p data-testid="static-reverse-blog">{blogUrl}</p>
      <p data-testid="static-reverse-href">{hrefUrl}</p>
    </div>
  );
});

// Prerender handler that pushes a breadcrumb whose `content` is a
// Promise<ReactNode>. Regression for the prerender handle-serialization bug: the
// content must survive the build artifact / dev wire (Flight-encoded), not be
// flattened to {} by JSON. TrailBreadcrumbs renders the restored content via
// use() + Suspense, so the testid only appears if the Promise<ReactNode> handle
// value round-tripped through the prerender store.
export const PrerenderHandle = Prerender(async (ctx) => {
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Home", href: "/" });
  breadcrumb({
    label: "Prerender Handle",
    href: "/prerender-handle",
    content: Promise.resolve(
      <span data-testid="prerender-handle-content">async-crumb-content</span>,
    ),
  });
  // Top-level DEFERRED crumb: reserve the slot via .defer() in the handler, then
  // resolve it from a deep async component during the prerender render. resolve-
  // by-default awaits it (resolveSegmentHandleValues) before baking, so the
  // artifact holds the RESOLVED crumb, not a Promise.
  const resolveDeferredCrumb = breadcrumb.defer({ timeoutMs: 5000 });
  async function DeepCrumbResolver() {
    await Promise.resolve();
    resolveDeferredCrumb({
      label: "Prerender Deferred Crumb",
      href: "/prerender-handle/deferred",
    });
    return null;
  }

  // The app's global breadcrumb component (rendered by the root layout) displays
  // the pushed crumbs, including the Promise<ReactNode> content via use().
  return (
    <div data-testid="prerender-handle-page">
      <h1 data-testid="prerender-handle-title">Prerender Handle</h1>
      <Suspense>
        <DeepCrumbResolver />
      </Suspense>
    </div>
  );
});

// Prerender + ppr composition (docs/design/shell-fast-path.md): the SAME route
// carries a build-time prerendered handler (trie pr:true) AND the ppr shell
// option. Capture and serve both go through the prerender-store hit in
// withCacheLookup: the build-time segments — the article content AND the
// slot handler element — bake into the frozen prelude; the SLOT-owned loader
// (loader()+loading() on the @ppseq parallel: the slot-hole playbook) is
// masked at capture and re-runs fresh per HIT (seq advances). A route-level
// loading() would instead make the WHOLE route subtree the hole — the live
// data must ride a slot for the prerendered content to be shell material.
// The Prerender handler never executes at serve (production evicts it to a
// stub; the store hit replays segments in dev too).
let prerenderPprSeq = 0;

export const PrerenderPprSeqLoader = createLoader(
  async (): Promise<{ seq: number }> => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    prerenderPprSeq += 1;
    return { seq: prerenderPprSeq };
  },
);

function PrerenderPprSeqSlot() {
  return <PrerenderPprSeq loader={PrerenderPprSeqLoader} />;
}

export const PrerenderPprArticle = Prerender(
  // "warm" is the e2e warm-up slug: the suite's beforeAll polls its bare path
  // to HIT so the producer-B machinery (dev: the /__rsc_shell on-demand
  // capture graph) is hot before the strict first-request assertions run on
  // the virgin alpha/beta bare paths.
  async () => [{ slug: "alpha" }, { slug: "beta" }, { slug: "warm" }],
  async (ctx) => {
    return (
      <div data-testid="pp-article">
        <h1 data-testid="pp-article-title">{`PP ${ctx.params.slug}`}</h1>
        <p data-testid="pp-article-content">
          {`Prerendered shell content for ${ctx.params.slug}`}
        </p>
        <ParallelOutlet name="@ppseq" />
      </div>
    );
  },
);

const prerenderPprBuildDynamicMiddleware: Middleware = async (ctx, next) => {
  if (ctx.build) {
    ctx.waitUntil(async () => {
      throw new Error("build waitUntil should not run during shell capture");
    });
    ctx.dynamic();
  }
  return next();
};

export const PrerenderPprBuildDynamicArticle = Prerender(
  async () => [{ slug: "delta" }],
  async (ctx) => {
    return (
      <div data-testid="pp-build-dynamic-article">
        <p data-testid="pp-build-dynamic-article-content">
          {`Build-dynamic shell content for ${ctx.params.slug}`}
        </p>
        <ParallelOutlet name="@ppseq" />
      </div>
    );
  },
);

const prerenderPprRuntimeDynamicMiddleware: Middleware = async (ctx, next) => {
  ctx.dynamic();
  return next();
};

export const PrerenderPprRuntimeDynamicArticle = Prerender(
  async () => [{ slug: "omega" }],
  async (ctx) => {
    return (
      <div data-testid="pp-runtime-dynamic-article">
        <p data-testid="pp-runtime-dynamic-article-content">
          {`Runtime-dynamic shell content for ${ctx.params.slug}`}
        </p>
      </div>
    );
  },
);

/**
 * Dedicated fixture for the build-shell EVICTION e2e (#699): its own route +
 * tag so updateTag("pp-evict-shell") cannot blast the sibling /pp/:slug
 * entries a concurrently-running test is asserting on (dev runs
 * fullyParallel). Same slot-hole shape as /pp/:slug.
 */
export const PrerenderPprEvictArticle = Prerender(
  async () => [{ slug: "gamma" }],
  async (ctx) => {
    return (
      <div data-testid="pp-evict-article">
        <p data-testid="pp-evict-article-content">
          {`Evictable shell content for ${ctx.params.slug}`}
        </p>
        <ParallelOutlet name="@ppseq" />
      </div>
    );
  },
);

export const prerenderPatterns = urls(
  ({ path, loader, loading, parallel, middleware, notFoundBoundary }) => [
    path("/prerender-handle", PrerenderHandle, { name: "prerender-handle" }),
    path("/docs", DocsPage, { name: "docs" }),
    // Prerender + ppr on ONE route: build-time segments become the frozen
    // prelude; the slot-owned loader is the badge-sized streaming hole.
    path(
      "/pp/:slug",
      PrerenderPprArticle,
      { name: "pp.article", ppr: { ttl: 300, swr: 120 } },
      () => [
        parallel({
          "@ppseq": {
            handler: PrerenderPprSeqSlot,
            use: () => [
              loader(PrerenderPprSeqLoader),
              loading(
                <span data-testid="pp-seq-fallback">Loading pp seq...</span>,
              ),
            ],
          },
        }),
      ],
    ),
    // Build-shell eviction fixture (#699): tagged so updateTag can reject the
    // baked entry via the store's tag markers (manifest entries are immutable
    // — eviction is a marker comparison, not a deletion).
    path(
      "/pp-evict/:slug",
      PrerenderPprEvictArticle,
      {
        name: "pp.evict",
        ppr: { ttl: 300, swr: 120, tags: ["pp-evict-shell"] },
      },
      () => [
        parallel({
          "@ppseq": {
            handler: PrerenderPprSeqSlot,
            use: () => [
              loader(PrerenderPprSeqLoader),
              loading(
                <span data-testid="pp-seq-fallback">Loading pp seq...</span>,
              ),
            ],
          },
        }),
      ],
    ),
    middleware(prerenderPprBuildDynamicMiddleware, () => [
      path(
        "/pp-build-dynamic/:slug",
        PrerenderPprBuildDynamicArticle,
        { name: "pp.build-dynamic", ppr: { ttl: 300, swr: 120 } },
        () => [
          parallel({
            "@ppseq": {
              handler: PrerenderPprSeqSlot,
              use: () => [
                loader(PrerenderPprSeqLoader),
                loading(
                  <span data-testid="pp-seq-fallback">Loading pp seq...</span>,
                ),
              ],
            },
          }),
        ],
      ),
    ]),
    middleware(prerenderPprRuntimeDynamicMiddleware, () => [
      path("/pp-runtime-dynamic/:slug", PrerenderPprRuntimeDynamicArticle, {
        name: "pp.runtime-dynamic",
        ppr: { ttl: 300, swr: 120 },
      }),
    ]),
    path("/docs/:slug", DocsArticle, { name: "docs.article" }, () => [
      loader(PrerenderTestLoader),
      notFoundBoundary(({ notFound: info }) => (
        <div data-testid="docs-not-found">
          <h1 data-testid="docs-not-found-title">Doc Not Found</h1>
          <p data-testid="docs-not-found-message">{info.message}</p>
        </div>
      )),
    ]),
    path("/changelog", ChangelogPage, { name: "changelog" }),
    // Static handler on a non-dynamic route
    path("/static-page", StaticPage, { name: "static-page" }),
    // Static handler on a dynamic route -- same content for any :tag value
    path("/static-shell/:tag", StaticShell, { name: "static-shell" }),
    // Prerender + Static handlers with reverse() -- tests URL generation at build time
    path("/prerender-reverse", PrerenderWithReverse, {
      name: "prerender-reverse",
    }),
    path("/static-reverse", StaticWithReverse, { name: "static-reverse" }),
  ],
);
