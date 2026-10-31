import { urls, loader, loading, revalidate } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";
import {
  ParallelInheritLoader,
  ParallelInheritRunsLoader,
} from "../loaders.js";
import { ParallelLoaderClient } from "../components/ParallelLoaderClient.js";
import {
  ParallelInheritMountProbe,
  ParallelInheritRuns,
} from "../components/ParallelInheritMountProbe.js";

/**
 * Regression test: loaders registered on the route via loader() DSL
 * should be accessible via useLoader() inside parallel() slots,
 * even when the parallel is nested inside a child layout.
 *
 * Variants:
 *   1. Without loading() — loaderData is synchronous on OutletProvider props
 *   2. With loading()    — loaderData is inside a LoaderBoundary element
 *   3. loading(false)    — no boundary, as 1: the layout's copy is dropped
 *   4. loading(fallback) with the route's handler held — an action re-runs
 *      the loader without the route segment; the layout keeps its copy
 *   5. loading(fallback, { ssr: false }) — no fallback on the document, the
 *      fallback on partials; the layout keeps its copy on both
 *
 * 4 and 5 put local state in the inner layout, which a remount resets.
 */
function probeLayout(slot: `@${string}`) {
  return () => (
    <div data-testid="inner-layout-probe">
      <ParallelInheritMountProbe />
      <Outlet />
      <ParallelOutlet name={slot} />
    </div>
  );
}
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

    // Variant 3: loading(false) — no boundary; the layout's copy is redundant
    path(
      "/parallel-loader-inherit-loading-off",
      () => (
        <div data-testid="parallel-loader-page-loading-off">
          <h1>Parallel Loader Inherit (loading off)</h1>
          <Outlet />
        </div>
      ),
      { name: "parallelLoaderInheritLoadingOff" },
      () => [
        loader(ParallelInheritLoader),
        loading(false),
        layout(
          () => (
            <div data-testid="inner-layout-loading-off">
              <Outlet />
              <ParallelOutlet name="@sidebar-loading-off" />
            </div>
          ),
          () => [
            parallel({
              "@sidebar-loading-off": () => (
                <div data-testid="parallel-sidebar-loading-off">
                  <ParallelLoaderClient />
                </div>
              ),
            }),
          ],
        ),
      ],
    ),

    // Variant 4: loading(fallback), the route's handler held on revalidation
    path(
      "/parallel-loader-inherit-held",
      () => <div data-testid="parallel-loader-page-held">held</div>,
      { name: "parallelLoaderInheritHeld" },
      () => [
        loader(ParallelInheritRunsLoader),
        loading(<div data-testid="loading-fallback">Loading...</div>),
        revalidate(() => false),
        layout(probeLayout("@runs-held"), () => [
          parallel({ "@runs-held": () => <ParallelInheritRuns /> }),
        ]),
      ],
    ),

    // Variant 5: loading(fallback, { ssr: false })
    path(
      "/parallel-loader-inherit-ssr-off",
      () => <div data-testid="parallel-loader-page-ssr-off">ssr off</div>,
      { name: "parallelLoaderInheritSsrOff" },
      () => [
        loader(ParallelInheritRunsLoader),
        loading(<div data-testid="loading-fallback">Loading...</div>, {
          ssr: false,
        }),
        layout(probeLayout("@runs-ssr-off"), () => [
          parallel({ "@runs-ssr-off": () => <ParallelInheritRuns /> }),
        ]),
      ],
    ),
  ],
);
