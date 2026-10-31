import {
  urls,
  loader,
  loading,
  revalidate,
  type Handler,
} from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { ParallelInheritRunsLoader } from "./parallel-loader-inherit.defs.js";
import {
  ParallelInheritMountProbe,
  ParallelInheritRuns,
} from "./parallel-loader-inherit.client.js";

/**
 * A route's loader, held on every partial, read through useLoader() from a
 * parallel slot of a child layout. With no loading() fallback the layout's
 * inherited copy of the loader is redundant and never sent, so the layout
 * holds the same loader entries on the document, an action and a same-route
 * navigation, and keeps its local state (rango-t156). The fixture of
 * tests/shared-e2e/src/parallel-loader-inherit-held-scenario.ts, which the
 * router's test-app runs too.
 */

let pageRenders = 0;
function revalidatingPage(testIdName: string, pathname: string): Handler {
  return (ctx) => (
    <div data-testid={testIdName}>
      <span data-testid="pli-renders">{++pageRenders}</span>
      <span data-testid="pli-x">{ctx.searchParams.get("x") ?? ""}</span>
      <Link
        to={`${pathname}?x=2` as string}
        prefetch="none"
        data-testid="pli-nav"
      >
        x=2
      </Link>
      <Outlet />
    </div>
  );
}

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
