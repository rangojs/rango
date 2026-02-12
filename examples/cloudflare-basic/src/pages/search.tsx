/**
 * Search page handler with type-safe search params via Handler<"search">.
 * ctx.searchParams is typed as { q: string; page?: number; sort?: string }
 * from the search schema defined on the route in urls.tsx.
 *
 * Handler defaults to GeneratedRouteMap (from gen file), so no explicit
 * route map import is needed.
 */
import type { Handler } from "@rangojs/router";

export const SearchPage: Handler<"search"> = (ctx) => {
  const { q, page, sort } = ctx.searchParams;
  const nextPage = (page ?? 1) + 1;
  const nextPageUrl = `/search?q=${encodeURIComponent(q)}&page=${nextPage}`;

  return (
    <main data-testid="search-page">
      <h1 data-testid="search-title">Search Results</h1>

      <section data-testid="search-params-display">
        <p data-testid="search-q">q: {q}</p>
        <p data-testid="search-page-num">
          page: {page !== undefined ? String(page) : "undefined"}
        </p>
        <p data-testid="search-sort">
          sort: {sort !== undefined ? sort : "undefined"}
        </p>
        <p data-testid="search-q-type">q-type: {typeof q}</p>
        <p data-testid="search-page-type">
          page-type: {page !== undefined ? typeof page : "undefined"}
        </p>
      </section>

      <section data-testid="search-reverse-urls">
        <p data-testid="search-next-page-url">next-page: {nextPageUrl}</p>
      </section>
    </main>
  );
};
