import { urls, loader, revalidate } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { ParallelRevalLoader } from "../loaders.js";
import { ParallelRevalClient } from "../components/ParallelRevalClient.js";

/**
 * Regression test: loaders registered on a parallel() entry with
 * revalidate(() => true) should produce consistent segment IDs
 * across fresh and revalidation code paths.
 *
 * Bug: resolveOrphanLayoutWithRevalidation used the parallel entry's
 * own shortCode (e.g., M0L0P0) instead of the parent layout's
 * shortCode (M0L0) for loader segment IDs, causing a mismatch
 * between the ID the client knows and the ID the server returns.
 * This made useLoader() unable to find the data after navigation.
 */
export const parallelLoaderRevalPatterns = urls(
  ({ path, layout, parallel }) => [
    layout(
      () => (
        <div data-testid="reval-layout">
          <ParallelOutlet name="@counter" />
          <Outlet />
        </div>
      ),
      () => [
        parallel(
          {
            "@counter": () => (
              <div data-testid="parallel-counter">
                <ParallelRevalClient />
              </div>
            ),
          },
          () => [loader(ParallelRevalLoader, () => [revalidate(() => true)])],
        ),
      ],
    ),

    path(
      "/parallel-loader-reval/page-a",
      () => (
        <div data-testid="reval-page-a">
          <h1>Page A</h1>
          <Link to="/parallel-loader-reval/page-b" data-testid="link-to-b">
            Go to Page B
          </Link>
        </div>
      ),
      { name: "parallelRevalPageA" },
    ),

    path(
      "/parallel-loader-reval/page-b",
      () => (
        <div data-testid="reval-page-b">
          <h1>Page B</h1>
          <Link to="/parallel-loader-reval/page-a" data-testid="link-to-a">
            Go to Page A
          </Link>
        </div>
      ),
      { name: "parallelRevalPageB" },
    ),
  ],
);
