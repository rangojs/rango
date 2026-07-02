import { urls } from "@rangojs/router";

/**
 * Named catch-all routes (issue #634) + the bare `*` wildcard (issue #636).
 *
 * `:slug*` is zero-or-more (Next `[[...slug]]`): it matches the bare prefix
 * (binding "") and any depth below it. `:path+` is one-or-more (Next
 * `[...path]` / React-Router splat): it requires at least one trailing segment.
 * Bare `/*` is the unnamed zero-or-more form: same semantics as `:name*` but the
 * remainder binds `ctx.params["*"]`. The matched remainder is exposed as a single
 * decoded string with the internal "/" separators preserved.
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
  path(
    "/files/*",
    (ctx) => {
      // Bare `*` binds the remainder under the key "*" at runtime (trie and regex
      // both do). `ExtractParams` only surfaces `:`-prefixed params, so the bare
      // wildcard key isn't in the params type yet — a typing gap orthogonal to
      // the #636 matching fix. Read it through a typed view until that's closed.
      const splat = (ctx.params as Record<string, string>)["*"];
      return (
        <div>
          <h1 data-testid="catchall-files-heading">Files</h1>
          <span data-testid="catchall-files-splat">{splat}</span>
          <span data-testid="catchall-files-empty">
            {splat === "" ? "empty" : "nonempty"}
          </span>
        </div>
      );
    },
    { name: "files" },
  ),
]);
