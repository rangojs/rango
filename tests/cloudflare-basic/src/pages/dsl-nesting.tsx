import { cache, layout, urls } from "@rangojs/router";
import type { Handler } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";

/**
 * A definition registers under the entry whose callback creates it
 * (assertDeclaredIn in @rangojs/router's route-definition/dsl-helpers.ts), so a
 * route created above the layout() that nests it is rejected where it is
 * written instead of rendering at the root with the layout silently gone and a
 * 200 response. Same fixture as the router's own e2e test-app, on workerd.
 *
 * - /dsl-nesting: the route is a const created inside the callback that nests
 *   it, so the layout's marker renders around it.
 * - /dsl-nesting/cached: a bare cache() wraps the siblings after it, which are
 *   declared one level below the callback's own entry and stay legal.
 *
 * RANGO_TEST_DECLARED_OUTSIDE=1 (inlined by vite.config.ts) swaps in the
 * rejected shape, so e2e/declared-outside.test.ts can watch discovery and the
 * build refuse it.
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
