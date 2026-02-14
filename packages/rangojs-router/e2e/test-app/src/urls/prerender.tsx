import { urls, Prerender } from "@rangojs/router";
import { ChangelogPage } from "./prerender-fs.js";
import { PrerenderTestLoader } from "../loaders.js";
import { PrerenderClientTest } from "../components/PrerenderClientTest.js";

// Static page -- no params, renders on-demand in dev mode
export const DocsPage = Prerender(
  async (ctx) => {
    return (
      <div data-testid="docs-page">
        <h1 data-testid="docs-title">Documentation</h1>
        <p data-testid="docs-content">This is pre-rendered documentation content.</p>
        <p data-testid="docs-pathname">Pathname: {ctx.pathname}</p>
      </div>
    );
  }
);

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
  }
);

export const prerenderPatterns = urls(({ path, loader }) => [
  path("/docs", DocsPage, { name: "docs" }),
  path("/docs/:slug", DocsArticle, { name: "docs.article" }, () => [
    loader(PrerenderTestLoader),
  ]),
  path("/changelog", ChangelogPage, { name: "changelog" }),
]);
