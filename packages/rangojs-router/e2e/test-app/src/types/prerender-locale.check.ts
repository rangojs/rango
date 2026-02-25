/**
 * Type-level tests for Prerender with parent route params.
 *
 * When Prerender is mounted under a parameterized include() prefix
 * (e.g., include("/:locale", ...)), the parent params are NOT part of
 * the path() pattern. This file verifies:
 *
 * 1. Prerender<{ slug: string }> works on path("/blog/:slug") -- VALID
 * 2. Prerender<{ locale: string; slug: string }> on path("/blog/:slug") -- TS ERROR
 *    because locale is not in the path pattern (it comes from include prefix)
 * 3. getParams can still return extra parent params at runtime (not checked by TS)
 *
 * This file is type-checked by tsc --noEmit.
 */

import { urls, Prerender } from "@rangojs/router";

// -- Valid: Prerender generic matches path pattern params ---------------------

const ValidDetail = Prerender<{ slug: string }>(
  async () => [{ slug: "hello" }],
  async (ctx) => {
    const _slug: string = ctx.params.slug;
    return null;
  },
  { passthrough: true },
);

// This works: path pattern has :slug, Prerender declares { slug: string }
const _validPatterns = urls(({ path }) => [
  path("/blog/:slug", ValidDetail, { name: "detail" }),
]);

// -- Invalid: Prerender declares params not in path pattern ------------------

const InvalidDetail = Prerender<{ locale: string; slug: string }>(
  async () => [{ locale: "en", slug: "hello" }],
  async (ctx) => {
    const _locale: string = ctx.params.locale;
    const _slug: string = ctx.params.slug;
    return null;
  },
  { passthrough: true },
);

const _invalidPatterns = urls(({ path }) => [
  // @ts-expect-error -- locale is not in path "/blog/:slug", it comes from parent include()
  path("/blog/:slug", InvalidDetail, { name: "detail" }),
]);

// -- Also invalid: completely wrong params -----------------------------------

const WrongParams = Prerender<{ category: string }>(
  async () => [{ category: "tech" }],
  async (ctx) => {
    const _cat: string = ctx.params.category;
    return null;
  },
  { passthrough: true },
);

const _wrongPatterns = urls(({ path }) => [
  // @ts-expect-error -- category is not in path "/blog/:slug"
  path("/blog/:slug", WrongParams, { name: "detail" }),
]);

// Suppress unused variable warnings
void _validPatterns;
void _invalidPatterns;
void _wrongPatterns;
