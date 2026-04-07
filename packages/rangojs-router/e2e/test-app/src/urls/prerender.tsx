import {
  urls,
  Prerender,
  Static,
  getRequestContext,
  Breadcrumbs,
} from "@rangojs/router";
import { ChangelogPage } from "./prerender-fs.js";
import { PrerenderTestLoader } from "../loaders.js";
import { PrerenderClientTest } from "../components/PrerenderClientTest.js";

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

export const prerenderPatterns = urls(({ path, loader, notFoundBoundary }) => [
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
]);
