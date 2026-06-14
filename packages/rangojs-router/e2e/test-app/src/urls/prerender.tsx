import {
  urls,
  Prerender,
  Static,
  getRequestContext,
  Breadcrumbs,
  cookies,
} from "@rangojs/router";
import { ChangelogPage } from "./prerender-fs.js";
import { PrerenderTestLoader } from "../loaders.js";
import { PrerenderClientTest } from "../components/PrerenderClientTest.js";
import {
  CachedInlineActionForm,
  type CachedInlineActionState,
} from "../components/CachedInlineActionForm.js";
import { fetchRandomAsyncValue } from "../inline-action-helpers.js";
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
  // The app's global breadcrumb component (rendered by the root layout) displays
  // the pushed crumbs, including the Promise<ReactNode> content via use().
  return (
    <div data-testid="prerender-handle-page">
      <h1 data-testid="prerender-handle-title">Prerender Handle</h1>
    </div>
  );
});

// Static handler embedding an inline "use server" action. The action closes over
// a BUILD-TIME token (frozen when the page is pre-rendered) and is handed to a
// client component. At runtime the worker serves the stored Flight (a build-time
// cache hit) WITHOUT re-running this handler, so the embedded action must resolve
// from the server-references manifest -- the same path that 500'd for "use cache"
// before the expose-action-id manifest re-assertion.
export const StaticInlineActionPage = Static(() => {
  const token = `stok-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`;

  async function staticInlineAction(
    _prev: CachedInlineActionState,
    _formData: FormData,
  ): Promise<CachedInlineActionState> {
    "use server";
    const asyncValue = await fetchRandomAsyncValue();
    const sessionCookie = cookies().get("cai-session")?.value ?? "none";
    return { capturedToken: token, asyncValue, sessionCookie };
  }

  return (
    <CachedInlineActionForm
      renderedToken={token}
      cachedAction={staticInlineAction}
    />
  );
});

// Prerendered, parameterized handler embedding an inline "use server" action --
// the canonical article-list + like-button case. Each param is pre-rendered at
// build time with its id captured (frozen) into the action's bound args; the
// action body runs live on click (fresh async value + live session cookie).
// Exercises the same manifest-resolution path on a prerender (build-time cache) hit.
export const PrerenderInlineActionPage = Prerender(
  async () => [{ id: "a1" }, { id: "a2" }],
  async (ctx) => {
    const articleId = ctx.params.id;

    async function likeAction(
      _prev: CachedInlineActionState,
      _formData: FormData,
    ): Promise<CachedInlineActionState> {
      "use server";
      const asyncValue = await fetchRandomAsyncValue();
      const sessionCookie = cookies().get("cai-session")?.value ?? "none";
      return { capturedToken: articleId, asyncValue, sessionCookie };
    }

    return (
      <CachedInlineActionForm
        renderedToken={articleId}
        cachedAction={likeAction}
      />
    );
  },
);

export const prerenderPatterns = urls(({ path, loader, notFoundBoundary }) => [
  path("/prerender-handle", PrerenderHandle, { name: "prerender-handle" }),
  path("/docs", DocsPage, { name: "docs" }),
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
  // Static + Prerender handlers embedding inline "use server" actions.
  path("/static-inline-action", StaticInlineActionPage, {
    name: "static-inline-action",
  }),
  path("/prerender-inline-action/:id", PrerenderInlineActionPage, {
    name: "prerender-inline-action",
  }),
]);
