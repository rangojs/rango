import { urls, createPrerenderHandler } from "@rangojs/router";

// Static page -- no params, renders on-demand in dev mode
export const DocsPage = createPrerenderHandler(
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

// Dynamic page -- with params
export const DocsArticle = createPrerenderHandler(
  async () => [{ slug: "getting-started" }, { slug: "api-reference" }],
  async (ctx) => {
    return (
      <div data-testid="docs-article">
        <h1 data-testid="docs-article-title">{ctx.params.slug}</h1>
        <p data-testid="docs-article-content">Content for {ctx.params.slug}</p>
      </div>
    );
  }
);

export const prerenderPatterns = urls(({ path }) => [
  path("/docs", DocsPage, { name: "docs" }),
  path("/docs/:slug", DocsArticle, { name: "docs.article" }),
]);
