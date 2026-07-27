import { Suspense } from "react";
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
  ShellExecLoader,
  ShellOutlinedBadgeLoader,
  shellExecCounters,
  ShellHandles,
  ShellStaleReplayHandle,
  SlowMetaHandles,
  makeBakedHandlePush,
  makeNestedHandlePush,
  makeNestedFastHandlePush,
  makeSlowMetaParts,
  makePhysicsPromise,
  makeShellStaleReplayData,
  getDriftStamp,
  getCapStamp,
  outlinedRenderCounter,
  ShellBakeSlowLoader,
  ShellBakeHoleLoader,
} from "./shell-cache.defs.js";
import { ShellSearchProbe } from "../components/ShellSearchProbe.js";
import { SlowMetaView } from "../components/SlowMetaView.js";
import { ShellBadge } from "../components/ShellBadge.js";
import { ShellSettledValue } from "../components/ShellSettledValue.js";
import { ShellGuardValue } from "../components/ShellGuardValue.js";
import { ShellCachePrice } from "../components/ShellCachePrice.js";
import { ShellCacheStream } from "../components/ShellCacheStream.js";
import { ShellCacheCounter } from "../components/ShellCacheCounter.js";
import { ShellPhysicsValue } from "../components/ShellPhysicsValue.js";
import { ShellHandleView } from "../components/ShellHandleView.js";
import { ShellExecMatrix } from "../components/ShellExecMatrix.js";
import { ShellBakeSlow } from "../components/ShellBakeSlow.js";
import { ShellStaleReplay } from "../components/ShellStaleReplay.js";
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
  pushShellHandle(makeNestedFastHandlePush());

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

// Static-part useSearchParams read above the live price hole: the probe's
// markup freezes into the per-search shell (see ShellSearchProbe).
function ShellSearchReadPage() {
  return (
    <section>
      <h2 data-testid="shell-searchread-header">Shell search read</h2>
      <ShellSearchProbe />
      <ShellCachePrice loader={ShellPriceLoader} />
    </section>
  );
}

// Large SYNCHRONOUS Suspense-wrapped section: fizz outlines any boundary over
// ~500 bytes (fallback inline first, content as a queued task) and, past
// progressiveChunkSize, outline-DEFERS it at flush (placeholder + out-of-band
// segment + $RC — all inside the stored prelude). Big enough that the section
// dominates the capture's fizz work: a capture abort that raced ready-but-
// queued render work would truncate it. Fizz's runnable work is microtask-
// atomic relative to the capture's macrotask abort schedule (tracked-postpones
// pings are scheduleMicrotask; the abort hops are setTimeout), so ready
// content of ANY size flushes before the abort can land — issue #702.
const OUTLINED_ROW_COUNT = 10000;

function OutlinedRows() {
  outlinedRenderCounter.count += 1;
  const renderCount = outlinedRenderCounter.count;
  return (
    <div data-testid="outlined-content">
      <span data-testid="outlined-render-count">{renderCount}</span>
      {Array.from({ length: OUTLINED_ROW_COUNT }, (_, i) => (
        <a
          key={i}
          href={`/shell-cache/outlined#row-${i}`}
          className="outlined-fixture-row transition-all duration-150 ease-in-out text-sm tracking-normal font-light border-neutral-200 hover:text-emphasis"
        >
          {`Outlined row ${i}`}
        </a>
      ))}
    </div>
  );
}

function ShellOutlinedPage() {
  return (
    <div>
      <p data-testid="outlined-static">Outlined page static</p>
      <Suspense
        fallback={<div data-testid="outlined-fallback">Loading section...</div>}
      >
        <OutlinedRows />
      </Suspense>
    </div>
  );
}

// Chrome layout for the outlined fixture: the masked hole is a SIBLING slot
// (@outlinedBadge, own loader + loading()), never an ANCESTOR of the section.
// Structural scar tissue (issue #702): a route-level loading() can NOT host
// this fixture — LoaderBoundary's LoaderResolver use()es the masked loader
// promise ABOVE the route subtree, so during capture nothing below it ever
// renders, and React postpones at Suspense-boundary granularity (the fallback
// occupies the boundary's DOM slot), so content inside the postponed boundary
// can never ride the prelude. Under loading(), the WHOLE route body is the
// hole by construction; static material that must bake belongs beside the
// hole (a slot, layout chrome) — the layout-with-loaders playbook.
function ShellOutlinedChromeLayout() {
  return (
    <main data-testid="shell-outlined-page">
      <ParallelOutlet name="@outlinedBadge" />
      <Outlet />
    </main>
  );
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

// Snapshot SIZE-CAP fixture layout (issue #651): same shape as the drift
// fixture — a cached stamp baked into the shell + the live price hole — but the
// route's ppr.maxSnapshotBytes is far below any real snapshot, so every capture
// skips the snapshot while still storing the shell. See getCapStamp.
async function CapStamp({ stamp }: { stamp: Promise<string> }) {
  return <p data-testid="cap-stamp">{await stamp}</p>;
}

function ShellCapLayout(ctx: HandlerContext) {
  const stamp = getCapStamp(ctx);
  return (
    <main data-testid="shell-cap-page">
      <h1 data-testid="shell-cap-header">Shell Cap Demo</h1>
      <CapStamp stamp={stamp} />
      <ShellCacheCounter />
      <Outlet />
    </main>
  );
}

function ShellCapPricePage() {
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
// Pin-first bake-lane layout (loader-cache.ts `if (!recorded.holes)`): registers
// ShellBakeSlowLoader — 600ms, NO loading() on the layout, so the BAKE lane. Its
// plain hole-free container bakes into the shell snapshot's loader family; on a
// HIT the record is hole-free, so the payload resolves the loaderData from the
// PIN immediately rather than gating on the slow fresh run. The child ppr route
// keeps a fast ~30ms price hole behind loading() so a real shell captures.
function ShellBakeSlowLayout() {
  return (
    <main data-testid="shell-bake-slow-page">
      <p data-testid="shell-bake-chrome">Bake slow static chrome</p>
      <Outlet />
    </main>
  );
}

function ShellBakeSlowPage() {
  return (
    <ShellBakeSlow
      bakeLoader={ShellBakeSlowLoader}
      holeLoader={ShellBakeHoleLoader}
    />
  );
}

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

// Shell fast-path execution matrix (docs/design/shell-fast-path.md): each
// layer increments its module counter; the DSL loader (live lane) reports the
// snapshot per serve. On a fast-path HIT, ONLY middleware + the loader may
// advance — the three handler counters are pinned frozen by the e2e (handlers
// are replayed from the captured doc segment record, never executed).
function ShellExecLayout() {
  shellExecCounters.layout += 1;
  return (
    <main data-testid="shell-exec-page">
      <p data-testid="shell-exec-chrome">Exec matrix static chrome</p>
      <ParallelOutlet name="@execBadge" />
      <Outlet />
    </main>
  );
}

function ShellExecBadgeSlot() {
  shellExecCounters.parallel += 1;
  return <span data-testid="shell-exec-badge">exec badge</span>;
}

function ShellExecPage() {
  shellExecCounters.path += 1;
  return <ShellExecMatrix loader={ShellExecLoader} />;
}

// Identity-guard negative page: renders the bake-lane identity loader's value.
function ShellGuardPage() {
  return <ShellGuardValue loader={ShellIdentityLoader} />;
}

// Settled-marker regression page (storefront PDP #438): see ShellSettledLoader.
function ShellSettledPage() {
  return <ShellSettledValue loader={ShellSettledLoader} />;
}

function ShellStaleReplayPage(ctx: HandlerContext<{ id: string }>) {
  const id = ctx.params.id;
  const data = makeShellStaleReplayData(id);
  const push = ctx.use(ShellStaleReplayHandle);
  push({ yo: `yo-${id}` });
  push(data.then((value) => ({ asd: value })));
  ctx.use(Meta)(
    data.then(async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { title: `Stale replay ${id}: ${value}` };
    }),
  );

  return (
    <Suspense fallback={<div>Loading stale replay {id}...</div>}>
      <ShellStaleReplay
        data={data}
        handle={ShellStaleReplayHandle}
        search={ctx.url.search}
      />
    </Suspense>
  );
}

// Slow deferred-shell-material layout (issue #715, the storefront meta
// pattern): three TOP-LEVEL pushes settling in parts — immediate, ~5.5s slow,
// and a Meta title CHAINED off the slow promise (+1s, ~6.5s total). The
// capture must ride the COMPLETE settlement sequence (never a partial prefix)
// and bake the final values; a budget that expires with pushes pending
// REFUSES the capture. Shared by the 10s-budget route (captures at ~6.5s)
// and the sub-settlement 1500ms-budget negative (eternal MISS) so the two
// differ ONLY in the captureTimeout value.
function ShellSlowMetaLayout(ctx: HandlerContext) {
  const parts = makeSlowMetaParts();
  const pushPart = ctx.use(SlowMetaHandles);
  pushPart(parts.immediate);
  pushPart(parts.slow);
  ctx.use(Meta)(parts.chainedTitle.then((title) => ({ title })));
  return (
    <main data-testid="shell-slow-meta-page">
      <p data-testid="shell-slow-meta-static">Slow meta static shell</p>
      <SlowMetaView />
      <Outlet />
    </main>
  );
}

// Storefront shape (PPR navigation replay composed with an explicit cache()):
// static layout chrome; the page embeds a per-execution stamp so a replayed
// serve (frozen stamp) is distinguishable from a fresh handler run.
function ShellScopedChromeLayout() {
  return (
    <main data-testid="shell-scoped-page">
      <p data-testid="shell-scoped-chrome">Scoped chrome static content</p>
      <Outlet />
    </main>
  );
}

let shellScopedExecution = 0;

function ShellScopedHomePage() {
  shellScopedExecution += 1;
  return (
    <p data-testid="shell-scoped-home">
      scoped-home-execution-{shellScopedExecution}
    </p>
  );
}

function ShellScopedOptOutPage() {
  return <p data-testid="shell-scoped-optout">Scoped opt-out static content</p>;
}

function ShellScopedConditionPage() {
  return (
    <p data-testid="shell-scoped-condition">Scoped condition static content</p>
  );
}

export const shellCachePatterns = urls(
  ({
    path,
    layout,
    loader,
    loading,
    middleware,
    parallel,
    transition,
    cache,
  }) => [
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
      // Static-part useSearchParams read: search is part of shell identity —
      // the key embeds the sorted search and the capture render seeds that
      // SAME string — so the probe's markup freezes into the per-search shell
      // (distinct query strings = distinct shells) and a HIT hydrates clean.
      // The price reader under loading() stays the live hole.
      path(
        "/shell-cache/search-read",
        ShellSearchReadPage,
        { name: "shellCacheSearchRead", ppr: { ttl: 300, swr: 120 } },
        () => [
          loader(ShellPriceLoader),
          loading(
            <div data-testid="shell-searchread-fallback">Loading price...</div>,
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
    // Snapshot SIZE-CAP route (issue #651): maxSnapshotBytes far below any real
    // snapshot → every capture skips the snapshot (over cap, stored WITHOUT it)
    // but the shell must still store and the HIT lane must serve + hydrate
    // cleanly — the cap degrades pinning, never serving. The cap-stamp's
    // default-profile ttl outlasts the test, so the un-pinned live re-read
    // matches the frozen prelude (drift after expiry is the documented trade).
    layout(ShellCapLayout, () => [
      path(
        "/shell-cache/snapshot-cap",
        ShellCapPricePage,
        {
          name: "shellCacheSnapshotCap",
          ppr: { ttl: 300, swr: 120, maxSnapshotBytes: 64 },
        },
        () => [
          loader(ShellPriceLoader),
          loading(<div data-testid="cap-price-fallback">Loading price...</div>),
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
    // Pin-first bake lane: see ShellBakeSlowLayout above. The layout's 600ms
    // hole-free bake loader is snapshot-pinned; on a HIT the payload resolves
    // it from the pin immediately (loader-cache.ts `if (!recorded.holes)`)
    // instead of gating on the fresh 600ms run. Child keeps a fast live price
    // hole behind loading() so a real shell captures.
    layout(ShellBakeSlowLayout, () => [
      loader(ShellBakeSlowLoader),
      path(
        "/shell-cache/bake-slow",
        ShellBakeSlowPage,
        { name: "shellCacheBakeSlow", ppr: { ttl: 300, swr: 120 } },
        () => [
          loader(ShellBakeHoleLoader),
          loading(
            <div data-testid="shell-bake-price-fallback">Loading price...</div>,
          ),
        ],
      ),
    ]),
    // Shell fast-path execution matrix: middleware + layout + parallel + path
    // + loader counters, asserted layer-by-layer across consecutive HITs. The
    // middleware is scoped to this subtree so its counter isolates the fixture.
    middleware(
      async (_ctx, next) => {
        shellExecCounters.middleware += 1;
        return next();
      },
      () => [
        layout(ShellExecLayout, () => [
          parallel({
            "@execBadge": {
              handler: ShellExecBadgeSlot,
            },
          }),
          path(
            "/shell-cache/exec-matrix",
            ShellExecPage,
            { name: "shellCacheExecMatrix", ppr: { ttl: 300, swr: 120 } },
            () => [
              transition({
                when: ({ nextUrl }) => {
                  shellExecCounters.transitionWhen += 1;
                  return nextUrl.searchParams.get("transition") !== "drop";
                },
              }),
              loader(ShellExecLoader),
              loading(
                <div data-testid="shell-exec-fallback">
                  Loading exec matrix...
                </div>,
              ),
            ],
          ),
        ]),
      ],
    ),
    // Outlined-boundary fixture (issue #702): a big sync Suspense section
    // beside a masked SLOT hole. The hole is a sibling (slot with its own
    // loader + loading()), never an ancestor — see ShellOutlinedChromeLayout
    // for why a route-level loading() cannot host this shape. Pins that
    // outlined-but-ready content bakes into the STORED prelude (green = every
    // row before the first </html>) while the masked hole still postpones
    // (badge fallback frozen in the prelude, value fresh in the resumed tail
    // on every HIT).
    layout(ShellOutlinedChromeLayout, () => [
      parallel({
        "@outlinedBadge": {
          handler: () => <ShellBadge loader={ShellOutlinedBadgeLoader} />,
          use: () => [
            loader(ShellOutlinedBadgeLoader),
            loading(
              <span data-testid="outlined-badge-fallback">
                outlined badge pending...
              </span>,
            ),
          ],
        },
      }),
      path("/shell-cache/outlined", ShellOutlinedPage, {
        name: "shellCacheOutlined",
        ppr: { ttl: 300, swr: 120 },
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
    path("/shell-cache/stale-replay/:id", ShellStaleReplayPage, {
      name: "shellCacheStaleReplay",
      ppr: { ttl: 300, swr: 120 },
    }),
    // Storefront shape: ppr routes under an ancestor cache() scope (the
    // rsc-cloudflare-app diagnosis shape — an app-wide cache() wrapping the
    // whole tree). Navigation replay COMPOSES with the explicit tier: the
    // tier's own hit reports `explicit-cache-hit`; on its miss the shell
    // snapshot's doc record supplies the match (`HIT`). Short ttl keeps the
    // explicit tier's warm window test-controllable; long swr mirrors the
    // storefront config.
    cache({ ttl: 30, swr: 604_800 }, () => [
      layout(ShellScopedChromeLayout, () => [
        path("/shell-cache/scoped", ShellScopedHomePage, {
          name: "shellCacheScoped",
          ppr: { ttl: 300, swr: 120 },
        }),
      ]),
      // Consumer opt-outs stay absolute on the replay path: cache(false) and
      // a false condition() report `cache-disabled` before any shell read.
      cache(false, () => [
        path("/shell-cache/scoped-optout", ShellScopedOptOutPage, {
          name: "shellCacheScopedOptOut",
          ppr: { ttl: 300, swr: 120 },
        }),
      ]),
      cache({ ttl: 30, condition: () => false }, () => [
        path("/shell-cache/scoped-condition", ShellScopedConditionPage, {
          name: "shellCacheScopedCondition",
          ppr: { ttl: 300, swr: 120 },
        }),
      ]),
    ]),
    // NAMELESS ppr route (issue #714): `name` is orthogonal to shell caching —
    // the DSL registers the entry under a synthesized $path_* manifest key with
    // the ppr option intact, so this route must engage (MISS -> HIT) exactly
    // like its named siblings. The param mirrors the issue's repro shape.
    path(
      "/shell-cache/nameless/:probe",
      ShellCachePricePage,
      { ppr: { ttl: 300, swr: 120 } },
      () => [
        loader(ShellPriceLoader),
        loading(
          <div data-testid="shell-nameless-fallback">Loading price...</div>,
        ),
      ],
    ),
    // Slow deferred shell material (issue #715): see ShellSlowMetaLayout. The
    // declared 10s budget admits the ~6.5s staged settlement; the sibling's
    // sub-settlement 1500ms budget refuses. TTL long past the test window so
    // no SWR recapture re-runs the slow pushes mid-test.
    layout(ShellSlowMetaLayout, () => [
      path(
        "/shell-cache/slow-meta",
        ShellCachePricePage,
        {
          name: "shellCacheSlowMeta",
          ppr: { ttl: 300, swr: 120, captureTimeout: 10000 },
        },
        () => [
          loader(ShellPriceLoader),
          loading(
            <div data-testid="slow-meta-price-fallback">Loading price...</div>,
          ),
        ],
      ),
      // Negative: identical material against an EXPLICIT sub-settlement
      // budget — 1500ms expires with pushes pending, the capture refuses (no
      // partial bake), and the route stays MISS with the once-per-key
      // warning. Explicit rather than no-knob since the default budget grew
      // to 15s, which ADMITS this ~6.5s material — a no-knob refusal would
      // need >15s material and ~30s test waits; the default VALUE is pinned
      // by the shell-capture unit test. Path/name keep the historical
      // "-default" suffix (stable warning regex + gen.ts).
      path(
        "/shell-cache/slow-meta-default",
        ShellCachePricePage,
        {
          name: "shellCacheSlowMetaDefault",
          ppr: { ttl: 300, swr: 120, captureTimeout: 1500 },
        },
        () => [
          loader(ShellPriceLoader),
          loading(
            <div data-testid="slow-meta-default-price-fallback">
              Loading price...
            </div>,
          ),
        ],
      ),
    ]),
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
    // Test-only fault injector for the serve-gate hardening e2e: overwrites the
    // stored shell entry for `target` with a corrupted/version-skewed copy, so
    // the suite can pin that the gate degrades to a working MISS (never a
    // committed-200 dead page) and that the recapture heals the key.
    // `mode`: postponed (unparseable JSON) | prelude (undecodable base64) |
    // build (stale buildVersion) | stale (rewrite with ttl=1). The key mirrors buildShellKey for the
    // single-search-param URLs the suite uses (sorted search == raw search).
    // router.js is imported dynamically to avoid the urls -> router cycle.
    path.json(
      "/shell-cache/__corrupt",
      async (
        ctx,
      ): Promise<{
        ok: boolean;
        found: boolean;
        segmentKeys?: string[];
      }> => {
        const url = new URL(ctx.request.url);
        const target = url.searchParams.get("target") ?? "";
        const mode = url.searchParams.get("mode") ?? "postponed";
        const { cacheStore } = await import("../router.js");
        const t = new URL(target, url);
        const key = `${t.host}${t.pathname}${t.search}:shell`;
        const hit = await cacheStore.getShell(key);
        if (!hit) return { ok: false, found: false };
        const entry = { ...hit.entry };
        if (mode === "postponed") entry.postponed = '{"truncated';
        else if (mode === "prelude") entry.prelude = "%%%not-base64%%%";
        else if (mode === "build") entry.buildVersion = "stale-build";
        await cacheStore.putShell(key, entry, mode === "stale" ? 1 : 300, 120);
        return {
          ok: true,
          found: true,
          segmentKeys: entry.snapshot
            ?.filter((record) => record.family === "segment")
            .map((record) => record.key),
        };
      },
      { name: "shellCacheCorrupt" },
    ),
  ],
);
