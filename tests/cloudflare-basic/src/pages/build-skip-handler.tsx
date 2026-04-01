import { Prerender, Passthrough, Static, Skip } from "@rangojs/router";

// Prerender handler that skips "draft" param via Skip at build time.
// Passthrough wraps with a live handler for runtime fallback.
export const SkipArticleDef = Prerender(
  async () => [{ slug: "published" }, { slug: "draft" }],
  async (ctx) => {
    if (ctx.params.slug === "draft") {
      throw new Skip("Draft articles are not pre-rendered");
    }
    return (
      <div data-testid="bs-article">
        <h1 data-testid="bs-article-title">{ctx.params.slug}</h1>
        <p data-testid="bs-article-content">Article: {ctx.params.slug}</p>
      </div>
    );
  },
);

export const SkipArticle = Passthrough(SkipArticleDef, async (ctx) => {
  if (ctx.params.slug === "draft") {
    throw new Skip("Draft articles are not pre-rendered");
  }
  return (
    <div data-testid="bs-article">
      <h1 data-testid="bs-article-title">{ctx.params.slug}</h1>
      <p data-testid="bs-article-content">Article: {ctx.params.slug}</p>
    </div>
  );
});

// Static handler that throws Skip -- excluded from build output.
export const SkipStaticHandler = Static(() => {
  throw new Skip("Static content not available");
});

// Normal Static handler that renders alongside the skipped one.
export const SkipWorkingStatic = Static(() => {
  return (
    <div data-testid="bs-working-static">
      <h1 data-testid="bs-working-static-title">Working Static</h1>
      <p data-testid="bs-working-static-timestamp">Built at: {Date.now()}</p>
    </div>
  );
});
