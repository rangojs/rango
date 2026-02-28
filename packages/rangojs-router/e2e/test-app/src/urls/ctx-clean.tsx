import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

/**
 * Test route for verifying that internal _rsc* params are stripped from ctx.
 *
 * The handler renders ctx.url.search and ctx.searchParams keys into the page.
 * An e2e test navigates here via client Link (which adds _rsc* params) and
 * verifies only user-facing params appear in the rendered output.
 */
export const ctxCleanPatterns = urls(({ path }) => [
  // Source page with link to target (for client-side navigation test)
  path(
    "/source",
    () => (
      <div data-testid="ctx-clean-source">
        <Link
          to="/ctx-clean?q=navigated&page=2"
          data-testid="navigate-to-target"
        >
          Navigate to target with params
        </Link>
      </div>
    ),
    { name: "source" },
  ),

  // Target page that renders ctx.url.search and searchParams keys
  path(
    "/",
    (ctx) => {
      const paramKeys = [...ctx.searchParams.keys()].sort().join(",");
      const urlSearch = ctx.url.search;
      return (
        <div data-testid="ctx-clean-page">
          <h1>Context Clean Test</h1>
          <p data-testid="ctx-url-search">{urlSearch}</p>
          <p data-testid="ctx-param-keys">{paramKeys}</p>
        </div>
      );
    },
    { name: "index" },
  ),
]);
