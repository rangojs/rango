/**
 * Type-level tests for Prerender with parent route params and named routes.
 *
 * DO NOT REMOVE @ts-expect-error lines — they are intentional test assertions
 * verifying that invalid usage produces type errors.
 *
 * Tests:
 * 1. Explicit params matching pattern — Prerender<{ slug: string }> on "/blog/:slug"
 * 2. Named route — Prerender<"locale.detail"> resolves full { locale, slug } from GeneratedRouteMap
 * 3. Superset params — Prerender<{ locale, slug }> on "/blog/:slug" (subset mounting)
 * 4. Wrong params — Prerender<{ category }> on "/blog/:slug" (TS error)
 * 5. Mismatched named route — Prerender<"blog.post"> on "/blog/:slug" (TS error)
 * 6. Include prefix param only — Prerender<{ locale }> on "/blog/:slug" (TS error)
 *    Handler has the parent include() param but is missing the path pattern param.
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

// path pattern has :slug, Prerender declares { slug: string } — exact match
const _validPatterns = urls(({ path }) => [
  path("/blog/:slug", ValidDetail, { name: "detail" }),
]);

// -- Valid: Named route resolves full params from GeneratedRouteMap -----------

const NamedRouteDetail = Prerender<"locale.detail">(
  async () => [{ locale: "en", slug: "hello" }],
  async (ctx) => {
    // Both locale and slug are typed — no cast needed
    const _locale: string = ctx.params.locale;
    const _slug: string = ctx.params.slug;
    return null;
  },
  { passthrough: true },
);

// Subset mounting: handler has { locale, slug } but pattern only has :slug.
// TParams extends ExtractParams<"/blog/:slug"> because { locale, slug } extends { slug }.
const _namedPatterns = urls(({ path }) => [
  path("/blog/:slug", NamedRouteDetail, { name: "detail" }),
]);

// -- Valid: Superset params (handler has more params than pattern) ------------

const SupersetDetail = Prerender<{ locale: string; slug: string }>(
  async () => [{ locale: "en", slug: "hello" }],
  async (ctx) => {
    const _locale: string = ctx.params.locale;
    const _slug: string = ctx.params.slug;
    return null;
  },
  { passthrough: true },
);

// Subset mounting: { locale, slug } extends { slug } — handler can have extra params
const _supersetPatterns = urls(({ path }) => [
  path("/blog/:slug", SupersetDetail, { name: "detail" }),
]);

// -- Invalid: completely wrong params (missing pattern params) ----------------

const WrongParams = Prerender<{ category: string }>(
  async () => [{ category: "tech" }],
  async (ctx) => {
    const _cat: string = ctx.params.category;
    return null;
  },
  { passthrough: true },
);

// { category } does NOT extend { slug } — slug is missing
const _wrongPatterns = urls(({ path }) => [
  // @ts-expect-error -- category is not in path "/blog/:slug", slug is missing
  path("/blog/:slug", WrongParams, { name: "detail" }),
]);

// -- Invalid: named route resolves params that don't match the path pattern ---

// "blog.post" resolves to { postId: string } from GeneratedRouteMap.
// Mounting on "/blog/:slug" requires { slug: string }.
// { postId } does NOT extend { slug } — slug is missing.
const MismatchedNamedRoute = Prerender<"blog.post">(
  async () => [{ postId: "hello" }],
  async (ctx) => {
    const _postId: string = ctx.params.postId;
    return null;
  },
  { passthrough: true },
);

const _mismatchedNamedPatterns = urls(({ path }) => [
  // @ts-expect-error -- "blog.post" has { postId } which doesn't match pattern "/blog/:slug"
  path("/blog/:slug", MismatchedNamedRoute, { name: "detail" }),
]);

// -- Invalid: has include prefix param but missing path pattern param ---------
// Simulates include("/:locale", ...) with path("/blog/:slug", handler).
// Handler has { locale } from the parent include() prefix but is missing slug.
// { locale } does NOT extend { slug } — slug is required by the pattern.

const IncludePrefixOnly = Prerender<{ locale: string }>(
  async () => [{ locale: "en" }],
  async (ctx) => {
    const _locale: string = ctx.params.locale;
    return null;
  },
  { passthrough: true },
);

const _includePrefixOnlyPatterns = urls(({ path }) => [
  // @ts-expect-error -- { locale } does not have slug required by "/blog/:slug"
  path("/blog/:slug", IncludePrefixOnly, { name: "detail" }),
]);

// Suppress unused variable warnings
void _validPatterns;
void _namedPatterns;
void _supersetPatterns;
void _wrongPatterns;
void _mismatchedNamedPatterns;
void _includePrefixOnlyPatterns;
