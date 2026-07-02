import { urls } from "@rangojs/router";

/**
 * Named catch-all routes (issue #634).
 *
 * `:slug*` is zero-or-more (Next `[[...slug]]`): it matches the bare prefix
 * (binding "") and any depth below it. `:path+` is one-or-more (Next
 * `[...path]` / React-Router splat): it requires at least one trailing segment.
 * The matched remainder is exposed as a single decoded string at
 * `ctx.params.<name>` with the internal "/" separators preserved.
 */
export const catchAllPatterns = urls(({ path }) => [
  path(
    "/docs/:slug*",
    (ctx) => (
      <div>
        <h1 data-testid="catchall-docs-heading">Docs</h1>
        <span data-testid="catchall-docs-slug">{ctx.params.slug}</span>
        <span data-testid="catchall-docs-empty">
          {ctx.params.slug === "" ? "empty" : "nonempty"}
        </span>
        <span data-testid="catchall-docs-reverse">
          {ctx.reverse("catchall.docs", { slug: "a/b" })}
        </span>
      </div>
    ),
    { name: "docs" },
  ),
  path(
    "/shop/:path+",
    (ctx) => (
      <div>
        <h1 data-testid="catchall-shop-heading">Shop</h1>
        <span data-testid="catchall-shop-path">{ctx.params.path}</span>
      </div>
    ),
    { name: "shop" },
  ),
]);
