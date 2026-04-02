import { urls, loader, loading } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";
import { ParallelInheritLoader } from "../loaders.js";
import { ParallelLoaderClient } from "../components/ParallelLoaderClient.js";

/**
 * Regression test: loaders registered on the route via loader() DSL
 * should be accessible via useLoader() inside parallel() slots,
 * even when the parallel is nested inside a child layout.
 *
 * Two variants:
 *   1. Without loading() — loaderData is synchronous on OutletProvider props
 *   2. With loading()    — loaderData is inside a LoaderBoundary element
 */
export const parallelLoaderInheritPatterns = urls(
  ({ path, layout, parallel }) => [
    // Variant 1: no loading() — synchronous loaderData
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
        loader(ParallelInheritLoader),
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

    // Variant 2: with loading() — loaderData inside LoaderBoundary
    path(
      "/parallel-loader-inherit-loading",
      () => (
        <div data-testid="parallel-loader-page-loading">
          <h1>Parallel Loader Inherit (loading)</h1>
          <Outlet />
        </div>
      ),
      { name: "parallelLoaderInheritLoading" },
      () => [
        loader(ParallelInheritLoader),
        loading(<div data-testid="loading-fallback">Loading...</div>),
        layout(
          () => (
            <div data-testid="inner-layout-loading">
              <Outlet />
              <ParallelOutlet name="@sidebar-loading" />
            </div>
          ),
          () => [
            parallel({
              "@sidebar-loading": () => (
                <div data-testid="parallel-sidebar-loading">
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
