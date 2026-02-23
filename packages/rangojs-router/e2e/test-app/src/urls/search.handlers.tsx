import type { HandlerContext } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

/**
 * Search index handler - tests typed search params.
 * Uses inline context type since search schema types flow from path() at runtime.
 */
export function SearchIndexHandler(ctx: HandlerContext<{}, any, { q: "string"; page: "number?"; sort: "string?" }>) {
  // ctx.search should be typed: { q: string; page?: number; sort?: string }
  const { q, page, sort } = ctx.search;

  // Build URLs manually for e2e testing (path-based reverse doesn't support search arg)
  const selfUrl = `/search?q=test&page=2`;
  const detailUrl = `/search/books?q=typescript&active=true`;

  return (
    <div data-testid="search-page">
      <h1 data-testid="search-title">Search Results</h1>

      <section data-testid="search-params-display">
        <p data-testid="search-q">q: {q}</p>
        <p data-testid="search-page-num">page: {page !== undefined ? String(page) : "undefined"}</p>
        <p data-testid="search-sort">sort: {sort !== undefined ? sort : "undefined"}</p>
        <p data-testid="search-q-type">q-type: {typeof q}</p>
        <p data-testid="search-page-type">page-type: {page !== undefined ? typeof page : "undefined"}</p>
      </section>

      <section data-testid="search-reverse-urls">
        <p data-testid="search-self-url">self: {selfUrl}</p>
        <p data-testid="search-detail-url">detail: {detailUrl}</p>
      </section>

      <nav data-testid="search-nav">
        <Link to={selfUrl} data-testid="search-self-link">
          Search &quot;test&quot; page 2
        </Link>
        {" | "}
        <Link to={detailUrl} data-testid="search-detail-link">
          Books: typescript
        </Link>
        {" | "}
        <Link to="/" data-testid="search-home-link">
          Home
        </Link>
      </nav>
    </div>
  );
}

/**
 * Search detail handler - tests typed search params with route params
 */
export function SearchDetailHandler(ctx: HandlerContext<{ category: string }, any, { q: "string?"; active: "boolean?" }>) {
  const { q, active } = ctx.search;

  return (
    <div data-testid="search-detail-page">
      <h1 data-testid="search-detail-title">Category: {ctx.params.category}</h1>

      <section data-testid="search-detail-params">
        <p data-testid="detail-q">q: {q !== undefined ? q : "undefined"}</p>
        <p data-testid="detail-active">active: {active !== undefined ? String(active) : "undefined"}</p>
        <p data-testid="detail-active-type">active-type: {active !== undefined ? typeof active : "undefined"}</p>
        <p data-testid="detail-category">category: {ctx.params.category}</p>
      </section>

      <nav>
        <Link to="/search" data-testid="detail-back-link">
          Back to Search
        </Link>
      </nav>
    </div>
  );
}
