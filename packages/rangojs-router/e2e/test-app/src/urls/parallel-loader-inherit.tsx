import {
  urls,
  loader,
  loading,
  revalidate,
  type Handler,
} from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
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
 *   3. loading(false)    — no boundary, as 1: the layout's copy is never sent
 *   4. loading(fallback) with the route's handler held — an action re-runs
 *      the loader without the route segment; the layout keeps its copy
 *   5. loading(fallback, { ssr: false }) — no fallback on the document, the
 *      fallback on partials; the layout keeps its copy on both
 *   6. the route's loader held, no loading() — the layout's copy is never
 *      sent, an action or a same-route navigation included
 *   7. as 6, with loading(false)
 *
 * 3 to 7 put local state in the inner layout, which a remount resets.
 * 6 and 7 are the fixture of tests/shared-e2e's
 * parallel-loader-inherit-held-scenario.ts.
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

/**
 * The route of variants 3, 6 and 7: its run count shows an action's
 * revalidation landed, and its link is a same-route navigation.
 */
let pageRenders = 0;
function revalidatingPage(testIdName: string, pathname: string): Handler {
  return (ctx) => (
    <div data-testid={testIdName}>
      <span data-testid="pli-renders">{++pageRenders}</span>
      <span data-testid="pli-x">{ctx.searchParams.get("x") ?? ""}</span>
      <Link to={`${pathname}?x=2`} prefetch="none" data-testid="pli-nav">
        x=2
      </Link>
      <Outlet />
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
      revalidatingPage(
        "parallel-loader-page-loading-off",
        "/parallel-loader-inherit-loading-off",
      ),
      { name: "parallelLoaderInheritLoadingOff" },
      () => [
        loader(ParallelInheritLoader),
        loading(false),
        layout(
          () => (
            <div data-testid="inner-layout-loading-off">
              <ParallelInheritMountProbe />
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

    // Variant 6: the route's loader held, no loading()
    path(
      "/parallel-loader-inherit-held-loader",
      revalidatingPage(
        "parallel-loader-page-held-loader",
        "/parallel-loader-inherit-held-loader",
      ),
      { name: "parallelLoaderInheritHeldLoader" },
      () => [
        loader(ParallelInheritRunsLoader, () => [revalidate(() => false)]),
        layout(probeLayout("@runs-held-loader"), () => [
          parallel({ "@runs-held-loader": () => <ParallelInheritRuns /> }),
        ]),
      ],
    ),

    // Variant 7: the route's loader held, loading(false)
    path(
      "/parallel-loader-inherit-held-loader-off",
      revalidatingPage(
        "parallel-loader-page-held-loader-off",
        "/parallel-loader-inherit-held-loader-off",
      ),
      { name: "parallelLoaderInheritHeldLoaderOff" },
      () => [
        loader(ParallelInheritRunsLoader, () => [revalidate(() => false)]),
        loading(false),
        layout(probeLayout("@runs-held-loader-off"), () => [
          parallel({ "@runs-held-loader-off": () => <ParallelInheritRuns /> }),
        ]),
      ],
    ),
  ],
);
