import { cache, layout, urls } from "@rangojs/router";
import type { Handler } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";

/**
 * A definition registers under the entry whose callback creates it
 * (assertDeclaredIn in route-definition/dsl-helpers.ts), so a route created
 * above the layout() that nests it is rejected where it is written instead of
 * rendering at the root with the layout silently gone and a 200 response.
 *
 * Two shapes that must keep working, both reachable in dev and production:
 * - /dsl-nesting: the route is a const created inside the callback that nests
 *   it. If the guard demanded exact entry identity instead of the callback's
 *   entry or a descendant, discovery would fail here; if the route escaped its
 *   layout the way the bug did, the layout's marker would leave the page.
 * - /dsl-nesting/cached: a bare cache() wraps the siblings after it, which are
 *   declared one level below the callback's own entry.
 *
 * RANGO_TEST_DECLARED_OUTSIDE=1 swaps in the rejected shape, so
 * e2e/declared-outside.test.ts can watch dev discovery and the production build
 * refuse it (a live app cannot hold it: it would take the whole app down).
 */

const DslNestingLayout: Handler = () => (
  <section data-testid="dsl-nesting-layout">
    <Outlet />
  </section>
);

const DslNestingPage: Handler = () => (
  <p data-testid="dsl-nesting-page">declared inside its layout callback</p>
);

const DslNestingCachedPage: Handler = () => (
  <p data-testid="dsl-nesting-cached-page">sibling of a bare cache()</p>
);

export const dslNestingPatterns = urls(
  ({ path, layout: nest, cache: wrap }) => {
    if (process.env.RANGO_TEST_DECLARED_OUTSIDE) {
      // Unnamed: the static route-type parser skips it, so the committed gen
      // file does not advertise a route that only exists under the flag.
      const outside = path("/declared-outside", DslNestingPage);
      return [nest(DslNestingLayout, () => [outside])];
    }
    return [
      nest(DslNestingLayout, () => {
        const inside = path("/", DslNestingPage, { name: "dslNesting" });
        return [inside];
      }),
      wrap({ ttl: 60 }),
      path("/cached", DslNestingCachedPage, { name: "dslNestingCached" }),
    ];
  },
);
