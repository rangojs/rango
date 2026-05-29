import { urls } from "@rangojs/router";
import type { ReactNode } from "react";

/**
 * Routes mounted under an optional include prefix (e.g.
 * `include("/:locale?", optionalIncludePatterns)`).
 *
 * The fixture pins the contract that optional include prefixes degrade to
 * "no prefix" — both `/` and `/<locale>` must match the index, and
 * `/c/:slug` must match both `/c/x` and `/<locale>/c/x`.
 *
 * Regression cover for the bug where `compilePattern("/:locale?")` produced
 * a regex that matched `""` and `/en` but not `/`, leaving the include's
 * index route 404 for non-localized requests.
 *
 * The `locale` param comes from the outer include's "/:locale?" prefix, not
 * from the inner pattern, so it isn't surfaced by the inner handler's typed
 * params — every handler reads it through a permissive cast.
 */

const readLocale = (ctx: { params: Record<string, unknown> }): string =>
  (ctx.params as { locale?: string }).locale ?? "";

const formatLocale = (locale: string): string =>
  locale === "" ? "(none)" : locale;

export const optionalIncludePatterns = urls(({ path }) => [
  path(
    "/",
    (ctx): ReactNode => (
      <div data-testid="optional-include-index">
        <h1 data-testid="optional-include-index-title">Index</h1>
        <p data-testid="optional-include-index-locale">
          locale={formatLocale(readLocale(ctx))}
        </p>
      </div>
    ),
    { name: "index" },
  ),
  path(
    "/c/:slug",
    (ctx): ReactNode => (
      <div data-testid="optional-include-category">
        <h1 data-testid="optional-include-category-title">
          Category: {ctx.params.slug}
        </h1>
        <p data-testid="optional-include-category-locale">
          locale={formatLocale(readLocale(ctx))}
        </p>
      </div>
    ),
    { name: "category" },
  ),
]);

/**
 * Same shape, but the optional include prefix is constrained to a known
 * locale set. `/fr` must 404 (constraint rejects `fr`), while `/`, `/en`,
 * and `/gb` must all match the index.
 */
export const constrainedOptionalIncludePatterns = urls(({ path }) => [
  path(
    "/",
    (ctx): ReactNode => (
      <div data-testid="constrained-optional-include-index">
        <p data-testid="constrained-optional-include-index-locale">
          locale={formatLocale(readLocale(ctx))}
        </p>
      </div>
    ),
    { name: "index" },
  ),
]);
