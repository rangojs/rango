import { urls, Meta, Breadcrumbs } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  ShellPriceLoader,
  ShellStreamLoader,
  ShellHandles,
  makeBakedHandlePush,
  makeNestedHandlePush,
  makePhysicsPromise,
} from "./shell-cache.defs.js";
import { ShellCachePrice } from "../components/ShellCachePrice.js";
import { ShellCacheStream } from "../components/ShellCacheStream.js";
import { ShellCacheCounter } from "../components/ShellCacheCounter.js";
import { ShellPhysicsValue } from "../components/ShellPhysicsValue.js";
import { ShellHandleView } from "../components/ShellHandleView.js";

// PPR shell caching demo (docs/design/ppr-shell-resume.md).
//
// Opt-in is the `ppr` path option on each page route below — a document-level
// property; there is no middleware to mount (serving is integral to the router)
// and the shell store is the app-level createRouter({ cache }) store.
//
// The hole doctrine this fixture exercises:
//   STRUCTURAL — the route loader behind loading(): masked at capture, the
//     LoaderBoundary postpones, the fallback bakes into the shell as route
//     structure. /shell-cache/no-hole is the negative (no loading(), capture
//     refuses, eternal MISS).
//   PHYSICS — ShellPhysicsValue: a handler-created pending promise (~250ms)
//     under the consumer's own Suspense. Real I/O cannot win the capture's
//     task-quantized quiet window, so the boundary postpones — a hole.
//   SHELL — static layout text, the interactive client island, handle reads,
//     and the TOP-LEVEL pushed handle promise (ShellHandles "baked" item):
//     awaited server-side before SSR, baked into the prelude.
//   HANDLES ("nesting = liveness") — ShellHandleView renders the pair: the
//     top-level promise push is baked; the container's NESTED promise streams
//     into its own Suspense — a hole. A promise nested inside your data is never
//     baked; the container settles.

function ShellCacheLayout(ctx: HandlerContext) {
  ctx.use(Meta)({ title: "Shell Cache" });
  ctx.use(Breadcrumbs)({ label: "Shell Cache", href: "/shell-cache" });

  // Handles pair: top-level promise (baked) + nested-in-container (hole).
  const pushShellHandle = ctx.use(ShellHandles);
  pushShellHandle(makeBakedHandlePush());
  pushShellHandle(makeNestedHandlePush());

  return (
    <main data-testid="shell-cache-page">
      <h1 data-testid="shell-cache-header">Shell Cache Demo</h1>
      <p data-testid="shell-cache-static">
        Static shell content frozen into the cached prelude.
      </p>
      <ShellCacheCounter />
      <ShellPhysicsValue promise={makePhysicsPromise()} />
      <ShellHandleView />
      <Outlet />
      <nav>
        <Link to="/" data-testid="shell-nav-home">
          Home
        </Link>
      </nav>
    </main>
  );
}

function ShellCachePricePage() {
  return <ShellCachePrice loader={ShellPriceLoader} />;
}

// Loader-carried-promise page, reused by BOTH /shell-cache/stream (WITH
// loading(), so the loader is a PPR hole) and /shell-cache/no-hole (NO loading(),
// so capture refuses and the route stays MISS forever while the inner promise
// still streams under axis 1). Identical component both times — the ONLY
// difference is whether the route carries loading().
function ShellCacheStreamPage() {
  return <ShellCacheStream loader={ShellStreamLoader} />;
}

export const shellCachePatterns = urls(({ path, layout, loader, loading }) => [
  layout(ShellCacheLayout, () => [
    // ppr carries the WHOLE shell policy (ttl/swr/tags); no middleware exists.
    path(
      "/shell-cache",
      ShellCachePricePage,
      { name: "shellCache", ppr: { ttl: 300, swr: 120 } },
      () => [
        loader(ShellPriceLoader),
        loading(<div data-testid="shell-price-fallback">Loading price...</div>),
      ],
    ),
    // Loader-carried promise WITH loading(): the loading() boundary is the hole.
    // On a HIT the resume streams three layers in one body — cached shell, then
    // the outer loader value + the inner Suspense fallback, then the
    // nested-promise inner value + $RC.
    path(
      "/shell-cache/stream",
      ShellCacheStreamPage,
      { name: "shellCacheStream", ppr: { ttl: 300, swr: 120 } },
      () => [
        loader(ShellStreamLoader),
        loading(
          <div data-testid="shell-stream-fallback">Loading stream...</div>,
        ),
      ],
    ),
    // Same loader/component, ppr DECLARED, but NO loading(): the loading-less
    // branch awaits loader data at tree-build, so capture's masked loader pins
    // the tree and the sanity gate refuses — x-rango-shell stays MISS forever
    // (plus the once-per-key warning). The nested inner promise still streams
    // under axis 1 (no loading() degrades only the caching, never the route).
    path(
      "/shell-cache/no-hole",
      ShellCacheStreamPage,
      { name: "shellCacheNoHole", ppr: true },
      () => [loader(ShellStreamLoader)],
    ),
  ]),
]);
