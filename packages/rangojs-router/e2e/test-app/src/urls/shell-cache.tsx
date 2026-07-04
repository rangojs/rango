import { urls, Meta, Breadcrumbs, nonce } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import {
  ShellPriceLoader,
  ShellStreamLoader,
  ShellChromeLoader,
  ShellBadgeLoader,
  ShellHandles,
  makeBakedHandlePush,
  makeNestedHandlePush,
  makePhysicsPromise,
  getDriftStamp,
} from "./shell-cache.defs.js";
import { ShellBadge } from "../components/ShellBadge.js";
import { ShellCachePrice } from "../components/ShellCachePrice.js";
import { ShellCacheStream } from "../components/ShellCacheStream.js";
import { ShellCacheCounter } from "../components/ShellCacheCounter.js";
import { ShellPhysicsValue } from "../components/ShellPhysicsValue.js";
import { ShellHandleView } from "../components/ShellHandleView.js";
import { ThemeToggle } from "../components/ThemeToggle.js";

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
      {/* Raw-theme TEXT in the shell is the regression trigger for the theme
          fidelity test: the server resume renders the replayed capture
          initialTheme, so a storage-reading client initializer would produce
          different text, fail hydration, and wipe the FOUC class (the blog
          ThemeToggle bug). Do not remove. */}
      <ThemeToggle testId="shell-theme" />
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

// Async server component that awaits the drifting cached stamp. Rendered directly
// in the shell layout (above loading()), so its value is BAKED into the captured
// prelude. On a HIT after the "drift" profile's 1s ttl expired, the capture data
// snapshot replays the capture-time value, so the fresh hydration payload matches
// the frozen prelude — no mismatch, no content flash.
async function DriftStamp({ stamp }: { stamp: Promise<string> }) {
  return <p data-testid="drift-stamp">{await stamp}</p>;
}

// Drift fixture layout: baked (shell) drift stamp + the live price hole via the
// page's Outlet. The stamp drifts once its short-ttl cache entry expires; the
// price loader stays a live hole (seq advances every request). See
// docs/design/ppr-shell-resume.md ("the capture data snapshot").
function ShellDriftLayout(ctx: HandlerContext) {
  const stamp = getDriftStamp(ctx);
  return (
    <main data-testid="shell-drift-page">
      <h1 data-testid="shell-drift-header">Shell Drift Demo</h1>
      <DriftStamp stamp={stamp} />
      <Outlet />
    </main>
  );
}

function ShellDriftPricePage() {
  return <ShellCachePrice loader={ShellPriceLoader} />;
}

// Per-request CSP nonce set via the `nonce` ContextVar token in ROUTE middleware
// (issue #656). A shell is shared per host+URL, so baking one request's nonce into
// it would serve a frozen nonce to every visitor and break CSP for all but the
// capture request. A ppr route with an active per-request nonce — from the
// createRouter({ nonce }) provider OR a ctx.set(nonce, …) token write — must stay
// on axis 1 (x-rango-shell: MISS) with a once-per-key worker warning.
//
// The layout reads ctx.get(nonce) and renders it into the SHELL region (above the
// loading() hole), the exact material that would be frozen into a captured
// prelude. With the gate reading the token at the commit point (which runs AFTER
// the route middleware), capture never runs: every GET stays MISS and carries a
// DISTINCT nonce. This also pins the commit-point ordering — the DSL middleware's
// token write is visible to the gate.
function ShellNonceLayout(ctx: HandlerContext) {
  const requestNonce = ctx.get(nonce);
  return (
    <main data-testid="shell-nonce-page">
      <h1 data-testid="shell-nonce-header">Shell Nonce Demo</h1>
      <span
        data-testid="shell-nonce-value"
        data-nonce={requestNonce ?? "(none)"}
      />
      <Outlet />
    </main>
  );
}

function ShellNoncePricePage() {
  return <ShellCachePrice loader={ShellPriceLoader} />;
}

// LAYOUT-LOADER TRAP (the storefront shape): the layout registers a loader with
// NO loading() on the LAYOUT while the ppr child below carries its own loader +
// loading(). The child boundary does NOT unpin the parent — the tree-build await
// lives at the entry that REGISTERS the loaders (segment-system.tsx), so the
// capture's masked ShellChromeLoader pins the tree above <body>, the prelude
// comes back trivial, and the sanity gate refuses: x-rango-shell stays MISS
// forever while axis 1 stays healthy. Registration alone pins — nothing
// consumes ShellChromeLoader.
function ShellTrapChromeLayout() {
  return (
    <main data-testid="shell-trap-page">
      <p data-testid="shell-trap-chrome">Trap chrome static text</p>
      <Outlet />
    </main>
  );
}

// THE ESCAPE (skills/ppr "layout-with-loaders playbook"): the same chrome data
// owned by a @badge parallel slot with its OWN loading(). Slot-owned loaders get
// a per-slot LoaderBoundary, so the layout node has no loaders to await: chrome
// and the static page bake into the shell, the badge is a badge-sized hole, and
// the route flips to HIT with no loader or loading() of its own.
function ShellSlotChromeLayout() {
  return (
    <main data-testid="shell-slot-page">
      <p data-testid="shell-slot-chrome">Slot chrome static text</p>
      <ParallelOutlet name="@badge" />
      <Outlet />
    </main>
  );
}

function ShellSlotHomePage() {
  return <p data-testid="shell-slot-home">Slot home static content</p>;
}

export const shellCachePatterns = urls(
  ({ path, layout, loader, loading, middleware, parallel }) => [
    layout(ShellCacheLayout, () => [
      // ppr carries the WHOLE shell policy (ttl/swr/tags); no middleware exists.
      path(
        "/shell-cache",
        ShellCachePricePage,
        { name: "shellCache", ppr: { ttl: 300, swr: 120 } },
        () => [
          loader(ShellPriceLoader),
          loading(
            <div data-testid="shell-price-fallback">Loading price...</div>,
          ),
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
    // Capture-data-snapshot DRIFT route: the shell bakes a value from a short-ttl
    // cache() (getDriftStamp, "drift" profile, ttl 1s); the shell's own ttl is 300.
    // After the inner ttl expires, a HIT must still show the CAPTURE-time stamp
    // (seeded from the snapshot) — byte parity with the frozen prelude — while the
    // price loader hole stays live. See docs/design/ppr-shell-resume.md.
    layout(ShellDriftLayout, () => [
      path(
        "/shell-cache/drift",
        ShellDriftPricePage,
        { name: "shellCacheDrift", ppr: { ttl: 300, swr: 120 } },
        () => [
          loader(ShellPriceLoader),
          loading(
            <div data-testid="drift-price-fallback">Loading price...</div>,
          ),
        ],
      ),
    ]),
    // Per-request nonce via the ContextVar TOKEN in route middleware (issue #656).
    // Scoped to THIS subtree (not global) so it gates only this ppr route and
    // leaves the rest of the shell-cache suite capturable — a global token nonce
    // would gate every other ppr fixture and kill their HIT coverage.
    middleware(
      async (ctx, next) => {
        ctx.set(nonce, crypto.randomUUID());
        return next();
      },
      () => [
        layout(ShellNonceLayout, () => [
          path(
            "/shell-cache/nonce-token",
            ShellNoncePricePage,
            { name: "shellCacheNonceToken", ppr: { ttl: 300, swr: 120 } },
            () => [
              loader(ShellPriceLoader),
              loading(
                <div data-testid="shell-nonce-price-fallback">
                  Loading price...
                </div>,
              ),
            ],
          ),
        ]),
      ],
    ),
    // Layout-loader trap: see ShellTrapChromeLayout above.
    layout(ShellTrapChromeLayout, () => [
      loader(ShellChromeLoader),
      path(
        "/shell-cache/layout-loader",
        ShellCachePricePage,
        { name: "shellCacheLayoutLoader", ppr: true },
        () => [
          loader(ShellPriceLoader),
          loading(
            <div data-testid="trap-price-fallback">Loading price...</div>,
          ),
        ],
      ),
    ]),
    // Slot-hole escape: see ShellSlotChromeLayout above.
    layout(ShellSlotChromeLayout, () => [
      parallel({
        "@badge": {
          handler: () => <ShellBadge loader={ShellBadgeLoader} />,
          use: () => [
            loader(ShellBadgeLoader),
            loading(
              <span data-testid="shell-badge-fallback">badge pending...</span>,
            ),
          ],
        },
      }),
      path("/shell-cache/slot-hole", ShellSlotHomePage, {
        name: "shellCacheSlotHole",
        ppr: true,
      }),
    ]),
  ],
);
