import { urls, Meta, Breadcrumbs, nonce } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import {
  ShellPriceLoader,
  ShellStreamLoader,
  ShellChromeLoader,
  ShellBadgeLoader,
  ShellSrvBadgeLoader,
  ShellSrvChipLoader,
  ShellIdentityLoader,
  ShellSettledLoader,
  ShellHandles,
  makeBakedHandlePush,
  makeNestedHandlePush,
  makePhysicsPromise,
  getDriftStamp,
} from "./shell-cache.defs.js";
import { ShellBadge } from "../components/ShellBadge.js";
import { ShellSettledValue } from "../components/ShellSettledValue.js";
import { ShellGuardValue } from "../components/ShellGuardValue.js";
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
//     structure (the LIVE lane).
//   BAKE LANE — a loader WITHOUT loading() executes at capture: its settled
//     container bakes (snapshot-pinned on HITs), nested pending promises hole
//     at the consumer's own Suspense. /shell-cache/no-hole and the
//     layout-loader routes exercise it (docs/design/loader-container-bake.md).
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
// loading(): the LIVE lane — the whole loader value is the hole) and
// /shell-cache/no-hole (NO loading(): the BAKE lane — the outer label bakes
// and is snapshot-pinned on HITs; the nested promise holes at the inner
// Suspense). Identical component both times — the ONLY difference is the lane
// the loading() presence selects.
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

// LAYOUT-LOADER shapes (the storefront): the layout registers a loader with NO
// loading() on the LAYOUT — the BAKE lane. At capture ShellChromeLoader
// executes (the gate holds for its 100ms), its container bakes, and the page
// HITs; the ppr child's own loader stays on the LIVE lane behind loading().
// Before the bake lane this was the eternal-MISS trap (the child's loading()
// could not unpin the layout's boundary-less await).
function ShellTrapChromeLayout() {
  return (
    <main data-testid="shell-trap-page">
      <p data-testid="shell-trap-chrome">Trap chrome static text</p>
      <Outlet />
    </main>
  );
}

// LIVE-lane alternative (skills/ppr "layout-with-loaders playbook"): the same
// chrome data owned by a @badge parallel slot with its OWN loading(). Slot-owned
// loaders get a per-slot LoaderBoundary — a badge-sized GUARANTEED-fresh hole —
// where the bake lane would pin the value for the shell's lifetime. Chrome and
// the static page bake; the route needs no loader or loading() of its own.
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

// Consumption-lane rule (issue #672 / #674): server-side ctx.use consumption
// during capture — the loader EXECUTES and its cookies() read is exempt from
// the identity guard (the cache() precedent); no refusal, the routes flip
// MISS->HIT. Two consumption shapes under one layout pin where the value
// lands:
// - @srvBadge: the slot HANDLER consumes a loader that is ALSO registered as
//   a live-lane segment (loader()+loading()). The segment lane is unchanged
//   by the rule — its masked loaderData pins the slot's boundary, so the
//   slot stays a LIVE hole (fallback frozen, value fresh per serve).
// - the chip: the LAYOUT handler consumes an UNREGISTERED loader and renders
//   it straight into shell material — the capture-time value (seq + cookie
//   identity) BAKES into the shared prelude, frozen across HITs and visitors
//   (the rule's documented footgun; client-side useLoader is the live lane,
//   see ShellSlotChromeLayout above).
// Before the rule, the guard tripped on either shape and every route under
// this layout stuck on x-rango-shell: MISS forever.
async function ShellSrvSlotLayout(ctx: HandlerContext) {
  const chip = await ctx.use(ShellSrvChipLoader);
  return (
    <main data-testid="shell-srv-slot-page">
      <p data-testid="shell-srv-slot-chrome">Srv slot chrome static text</p>
      <span data-testid="shell-srv-chip">{chip}</span>
      <ParallelOutlet name="@srvBadge" />
      <Outlet />
    </main>
  );
}

async function ShellSrvBadgeSlot(ctx: HandlerContext) {
  const value = await ctx.use(ShellSrvBadgeLoader);
  return <span data-testid="shell-srv-badge">{value}</span>;
}

function ShellSrvSlotHomePage() {
  return <p data-testid="shell-srv-slot-home">Srv slot home static content</p>;
}

function ShellSrvSlotOtherPage() {
  return (
    <p data-testid="shell-srv-slot-other">Srv slot other static content</p>
  );
}

function ShellBareHomePage() {
  return <p data-testid="shell-bare-home">Bare home static content</p>;
}

// Identity-guard negative page: renders the bake-lane identity loader's value.
function ShellGuardPage() {
  return <ShellGuardValue loader={ShellIdentityLoader} />;
}

// Settled-marker regression page (storefront PDP #438): see ShellSettledLoader.
function ShellSettledPage() {
  return <ShellSettledValue loader={ShellSettledLoader} />;
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
      // The literal storefront-homepage shape: a BARE ppr route (no loader, no
      // loading(), no use list at all) under the loader-registering layout. The
      // route itself is fully shell-eligible; the LAYOUT's boundary-less loader
      // alone keeps the capture refusing.
      path("/shell-cache/layout-loader-bare", ShellBareHomePage, {
        name: "shellCacheLayoutLoaderBare",
        ppr: true,
      }),
    ]),
    // Settled-marker regression (storefront PDP #438): bake-lane loader whose
    // nested promise is already resolved at container return — the snapshot
    // pins its value; the HIT overlay must rehydrate a Promise for use().
    path(
      "/shell-cache/settled",
      ShellSettledPage,
      { name: "shellCacheSettled", ppr: true },
      () => [loader(ShellSettledLoader)],
    ),
    // Identity-guard negative: a bake-lane loader (no loading()) that reads
    // cookies(). Capture refuses deterministically (guard flag) — MISS forever
    // — while axis 1 serves the per-user value normally.
    path(
      "/shell-cache/guard",
      ShellGuardPage,
      {
        name: "shellCacheGuard",
        ppr: true,
      },
      () => [loader(ShellIdentityLoader)],
    ),
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
    // Server-side slot consumption (issue #672): see ShellSrvSlotLayout above.
    // TWO sibling ppr routes under ONE slot-owning layout pin that the mask
    // does not depend on which route is captured.
    layout(ShellSrvSlotLayout, () => [
      parallel({
        "@srvBadge": {
          handler: ShellSrvBadgeSlot,
          use: () => [
            loader(ShellSrvBadgeLoader),
            loading(
              <span data-testid="shell-srv-badge-fallback">
                srv badge pending...
              </span>,
            ),
          ],
        },
      }),
      path("/shell-cache/slot-use", ShellSrvSlotHomePage, {
        name: "shellCacheSlotUse",
        ppr: true,
      }),
      path("/shell-cache/slot-use/other", ShellSrvSlotOtherPage, {
        name: "shellCacheSlotUseOther",
        ppr: true,
      }),
    ]),
  ],
);
