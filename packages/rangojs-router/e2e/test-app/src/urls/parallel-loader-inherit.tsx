import { urls, loader } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";
import { ParallelInheritLoader } from "../loaders.js";
import { ParallelLoaderClient } from "../components/ParallelLoaderClient.js";

/**
 * Regression test: loaders registered on the route via loader() DSL
 * should be accessible via useLoader() inside parallel() slots,
 * even when the parallel is nested inside a child layout.
 *
 * Route structure:
 *   path("/parallel-loader-inherit", Handler, () => [
 *     loader(ParallelInheritLoader),       ← registered on the route
 *     layout(InnerLayout, () => [
 *       parallel({ "@sidebar": ... }),      ← useLoader here should see the route loader
 *     ]),
 *   ])
 */
export const parallelLoaderInheritPatterns = urls(
  ({ path, layout, parallel }) => [
    path(
      "/parallel-loader-inherit",
      () => (
        <div data-testid="parallel-loader-page">
          <h1>Parallel Loader Inherit</h1>
          <Outlet />
        </div>
      ),
      { name: "parallelLoaderInherit" },
      () => [
        // Loader registered on the route
        loader(ParallelInheritLoader),
        // Nested layout with parallel — the parallel should inherit the route loader
        layout(
          () => (
            <div data-testid="inner-layout">
              <Outlet />
              <ParallelOutlet name="@sidebar" />
            </div>
          ),
          () => [
            parallel({
              "@sidebar": () => (
                <div data-testid="parallel-sidebar">
                  <ParallelLoaderClient />
                </div>
              ),
            }),
          ],
        ),
      ],
    ),
  ],
);
