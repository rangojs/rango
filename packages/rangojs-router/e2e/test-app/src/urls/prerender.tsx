import { urls, Prerender, Static } from "@rangojs/router";
import { ChangelogPage } from "./prerender-fs.js";
import { PrerenderTestLoader } from "../loaders.js";
import { PrerenderClientTest } from "../components/PrerenderClientTest.js";
import { Breadcrumbs } from "../handles.js";

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

export const prerenderPatterns = urls(({ path, loader }) => [
  path("/docs", DocsPage, { name: "docs" }),
  path("/docs/:slug", DocsArticle, { name: "docs.article" }, () => [
    loader(PrerenderTestLoader),
  ]),
  path("/changelog", ChangelogPage, { name: "changelog" }),
  // Static handler on a non-dynamic route
  path("/static-page", StaticPage, { name: "static-page" }),
  // Static handler on a dynamic route -- same content for any :tag value
  path("/static-shell/:tag", StaticShell, { name: "static-shell" }),
]);
