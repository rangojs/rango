import { urls, Prerender, Passthrough, Static, Skip } from "@rangojs/router";

// Prerender handler that skips one param via Skip at build time.
// "published" renders normally, "draft" is skipped at build time.
// The Passthrough live handler re-executes at runtime for skipped params.
export const SkipArticleDef = Prerender(
  async () => [{ slug: "published" }, { slug: "draft" }],
  async (ctx) => {
    if (ctx.params.slug === "draft") {
      throw new Skip("Draft articles are not pre-rendered");
    }
    return (
      <div data-testid="build-skip-article">
        <h1 data-testid="build-skip-article-title">{ctx.params.slug}</h1>
        <p data-testid="build-skip-article-content">
          Article: {ctx.params.slug}
        </p>
      </div>
    );
  },
);

export const SkipArticle = Passthrough(SkipArticleDef, async (ctx) => {
  if (ctx.params.slug === "draft") {
    throw new Skip("Draft articles are not pre-rendered");
  }
  return (
    <div data-testid="build-skip-article">
      <h1 data-testid="build-skip-article-title">{ctx.params.slug}</h1>
      <p data-testid="build-skip-article-content">Article: {ctx.params.slug}</p>
    </div>
  );
});

// Static handler that throws Skip -- should be excluded from build output.
export const SkipStatic = Static(() => {
  throw new Skip("Static content not available");
});

// Normal Static handler alongside the skipped one -- should still render.
export const SkipWorkingStatic = Static(() => {
  return (
    <div data-testid="build-skip-working-static">
      <h1 data-testid="build-skip-working-static-title">Working Static</h1>
      <p data-testid="build-skip-working-static-timestamp">
        Built at: {Date.now()}
      </p>
    </div>
  );
});

export const buildSkipPatterns = urls(({ path }) => [
  path("/static-skip", SkipStatic, { name: "staticSkip" }),
  path("/working-static", SkipWorkingStatic, { name: "workingStatic" }),
  path("/:slug", SkipArticle, { name: "article" }),
]);
