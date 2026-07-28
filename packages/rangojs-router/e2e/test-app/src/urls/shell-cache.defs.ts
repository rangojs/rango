import { createLoader, createHandle } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";

// Capture-data-snapshot DRIFT fixture (docs/design/ppr-shell-resume.md). A cached
// value baked into the PPR shell (above loading(), so it is prelude material) via
// the "drift" profile — ttl 1s, swr 0, so the underlying entry is fully GONE one
// second after capture. Every fresh execution returns a DISTINCT stamp, so a HIT
// after expiry would recompute a different value and drift from the frozen
// prelude — the exact hydration hazard the capture data snapshot pins. ctx is
// tainted, so the cache key is scoped per-URL (probe isolation like the shells).
let driftExecutions = 0;

export async function getDriftStamp(ctx: HandlerContext): Promise<string> {
  "use cache: drift";
  // ctx is a tainted key arg (excluded from the value, scopes the key by
  // pathname+search); reference it so the transform keeps it.
  void ctx.pathname;
  driftExecutions += 1;
  return `drift-${driftExecutions}`;
}

// Snapshot SIZE-CAP fixture (issue #651): a default-profile cached value baked
// into the shell above loading(). The route caps ppr.maxSnapshotBytes far below
// any real snapshot, so EVERY capture skips the snapshot (over cap, once-per-key
// warning) yet still stores the shell. A HIT's tail then re-reads this value
// LIVE from the real store — the default profile's ttl outlasts the test, so
// the un-pinned read returns the capture-time value and the page hydrates
// without mismatch. (Drift after expiry is the documented trade, exercised
// conceptually by the drift fixture above — not asserted here.)
let capStampExecutions = 0;

export async function getCapStamp(ctx: HandlerContext): Promise<string> {
  "use cache";
  // ctx is a tainted key arg (excluded from the value, scopes the key by
  // pathname+search); reference it so the transform keeps it.
  void ctx.pathname;
  capStampExecutions += 1;
  return `cap-stamp-${capStampExecutions}`;
}

// stream:"navigation" BAKE-lane fixtures. The flagged loader executes at
// capture: its settled top-level return is SHELL material (frozen, snapshot-
// pinned for HIT parity), while the NESTED promise in the same return stays a
// live hole (nested-thenable mask — shape is the liveness declaration). The
// monotonic seqs make frozen-vs-live observable: the baked seq must NOT
// advance across HITs while the nested/sibling seqs must.
let bakedNavSeq = 0;
let bakedNestedSeq = 0;

export interface ShellBakedNavData {
  title: string;
  slow: Promise<string>;
}

export const ShellBakedNavLoader = createLoader(
  async (): Promise<ShellBakedNavData> => {
    bakedNavSeq += 1;
    const nested = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      bakedNestedSeq += 1;
      return `nested-live-${bakedNestedSeq}`;
    })();
    return { title: `baked-nav-${bakedNavSeq}`, slow: nested };
  },
);

let bakedSiblingSeq = 0;

/** Plain (unflagged) sibling: live at capture, fresh per request. */
export const ShellBakedSiblingLoader = createLoader(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  bakedSiblingSeq += 1;
  return `sibling-live-${bakedSiblingSeq}`;
});

let bakedOnlySeq = 0;

/**
 * The loading()-optional pin: a route whose ONLY loader is flagged needs no
 * loading() at all — nothing masks at capture, the shell captures complete.
 */
export const ShellBakedOnlyLoader = createLoader(async () => {
  bakedOnlySeq += 1;
  return `baked-only-${bakedOnlySeq}`;
});

// Live hole under the frozen PPR shell (docs/design/ppr-shell-resume.md). ~400ms
// so the shell prelude clearly beats the hole; seq advances on every request to
// prove loaders stay fresh while the shell is served from the cached prelude.
// Directive-free so the client price component can import it by identity
// (useLoader) without pulling the route factory into the client graph.
const SHELL_LOADER_DELAY_MS = 400;

export interface ShellPriceData {
  price: number;
  seq: number;
  loadedAt: number;
}

let shellPriceSeq = 0;

export const ShellPriceLoader = createLoader(
  async (): Promise<ShellPriceData> => {
    await new Promise((resolve) => setTimeout(resolve, SHELL_LOADER_DELAY_MS));
    shellPriceSeq += 1;
    return { price: 42, seq: shellPriceSeq, loadedAt: Date.now() };
  },
);

// Loader-carried promise: the deterministic streaming lane under a PPR hole
// (docs/design/ppr-shell-resume.md). Resolves its OUTER value fast but carries a
// NESTED promise settling ~300ms later. FlightSerialize preserves the nested
// Promise (src/serialize.ts), so the client use()s it under its OWN inner
// Suspense — a second streaming layer INSIDE the loader hole. One loader backs
// both /shell-cache/stream (WITH loading(): the hole; HIT streams three layers)
// and /shell-cache/no-hole (NO loading(): capture refuses, eternal MISS, but the
// inner promise still streams under axis 1).
const SHELL_STREAM_INNER_DELAY_MS = 300;

export interface ShellStreamData {
  label: string;
  pendingData: Promise<string>;
}

let shellStreamSeq = 0;

export const ShellStreamLoader = createLoader(
  async (): Promise<ShellStreamData> => {
    shellStreamSeq += 1;
    const seq = shellStreamSeq;
    const pendingData = new Promise<string>((resolve) =>
      setTimeout(
        () => resolve(`Streamed inner ${seq}`),
        SHELL_STREAM_INNER_DELAY_MS,
      ),
    );
    // seq in the label makes the CONTAINER per-execution distinguishable, so
    // the bake-lane e2e can pin the snapshot overlay (outer seq frozen across
    // HITs) against the live nested lane (inner seq advancing).
    return { label: `Streamed outer ${seq}`, pendingData };
  },
);

// Handles contract fixture ("nesting = liveness"). The shell layout pushes TWO
// entries into this handle:
//   1. a TOP-LEVEL promise (the pushed value IS a promise, resolving after a real
//      ~150ms latency) — resolvedHandleStream awaits it before the payload's
//      handles row emits, and the capture gate is HELD open for the same await,
//      so the resolved value is BAKED into the shell prelude;
//   2. a CONTAINER carrying a NESTED promise ({ kind, pending }) — the shallow
//      isThenable resolution passes the container through verbatim, so the nested
//      promise streams to the consumer, who must Suspense it — a HOLE.
// Values are DETERMINISTIC (no seq): baked shell material must not drift between
// the captured prelude and the fresh hydration payload.
export interface ShellHandleItem {
  kind: "baked" | "nested" | "nested-fast";
  value?: string;
  pending?: Promise<string>;
}

export const ShellHandles = createHandle<ShellHandleItem, ShellHandleItem[]>(
  (values) => values.flat(),
);

export interface ShellStaleReplayHandleValue {
  yo?: string;
  asd?: string;
}

export const ShellStaleReplayHandle =
  createHandle<ShellStaleReplayHandleValue>();

let shellStaleReplayExecutions = 0;

export function makeShellStaleReplayData(id: string): Promise<string> {
  shellStaleReplayExecutions += 1;
  const execution = shellStaleReplayExecutions;
  return new Promise((resolve) =>
    setTimeout(
      () => resolve(`shell-stale-${id}-execution-${execution}`),
      1_500,
    ),
  );
}

const SHELL_HANDLE_BAKED_DELAY_MS = 150;
const SHELL_HANDLE_NESTED_DELAY_MS = 250;

/** Top-level promise push: baked into the shell once resolved. */
export function makeBakedHandlePush(): Promise<ShellHandleItem> {
  return new Promise((resolve) =>
    setTimeout(
      () => resolve({ kind: "baked", value: "TOP-LEVEL-BAKED" }),
      SHELL_HANDLE_BAKED_DELAY_MS,
    ),
  );
}

/**
 * Container push whose nested promise is ALREADY RESOLVED — the extreme of the
 * settle race. Shape is the liveness declaration: this must hole at capture
 * exactly like the slow nested push above, never bake its value into the
 * shared shell.
 */
export function makeNestedFastHandlePush(): ShellHandleItem {
  return {
    kind: "nested-fast",
    pending: Promise.resolve("NESTED-FAST-STREAMED"),
  };
}

/** Container push with a nested promise: the nested value stays a hole. */
export function makeNestedHandlePush(): ShellHandleItem {
  return {
    kind: "nested",
    pending: new Promise((resolve) =>
      setTimeout(
        () => resolve("NESTED-HANDLE-STREAMED"),
        SHELL_HANDLE_NESTED_DELAY_MS,
      ),
    ),
  };
}

// Physics fixture: a handler-created promise passed as a PROP to a client
// component that use()s it under its own <Suspense>. Genuinely pending real I/O
// (~250ms) cannot win the capture's task-quantized quiet window, so the boundary
// postpones — a HOLE by physics, not by registration. Deterministic value (no
// drift; the resumed HTML and hydration payload come from the same tail render).
const SHELL_PHYSICS_DELAY_MS = 250;

export function makePhysicsPromise(): Promise<string> {
  return new Promise((resolve) =>
    setTimeout(() => resolve("PHYSICS-HOLE-VALUE"), SHELL_PHYSICS_DELAY_MS),
  );
}

// Settled-marker regression fixture (the storefront PDP React #438): a
// bake-lane loader whose nested promise is ALREADY RESOLVED when the container
// returns. It always wins the capture window, so the snapshot pins its VALUE —
// wrapped in the settled marker, which the HIT overlay must rehydrate into
// Promise.resolve(value). The client consumer calls use(data.fast)
// unconditionally; handing it the raw value threw #438 and the root error
// boundary replaced the whole page.
export interface ShellSettledData {
  label: string;
  fast: Promise<string>;
}

let shellSettledSeq = 0;

export const ShellSettledLoader = createLoader(
  async (): Promise<ShellSettledData> => {
    shellSettledSeq += 1;
    return {
      label: `Settled outer ${shellSettledSeq}`,
      fast: Promise.resolve(`Settled fast ${shellSettledSeq}`),
    };
  },
);

// Layout-loader bake-lane fixture (the storefront shape: an app-wide layout
// registering session/basket-style loaders, no loading() on the layout).
// Executes at capture (the gate holds for the 100ms), bakes, and is
// snapshot-pinned on HITs. Consumed by nothing — the lane decision is
// registration-level, not consumption-level.
const SHELL_CHROME_DELAY_MS = 100;

let shellChromeSeq = 0;

export const ShellChromeLoader = createLoader(async (): Promise<string> => {
  await new Promise((resolve) => setTimeout(resolve, SHELL_CHROME_DELAY_MS));
  shellChromeSeq += 1;
  return `chrome-${shellChromeSeq}`;
});

// Slot live-lane fixture: the SAME chrome-data shape as ShellChromeLoader, but
// owned by a @badge parallel slot with its own loading(), so it gets a
// per-slot LoaderBoundary — masked at capture, GUARANTEED fresh per serve
// (where the bake lane would pin it). seq advances on every execution to prove
// the badge stays live across shell HITs.
const SHELL_BADGE_DELAY_MS = 150;

let shellBadgeSeq = 0;

export const ShellBadgeLoader = createLoader(async (): Promise<string> => {
  await new Promise((resolve) => setTimeout(resolve, SHELL_BADGE_DELAY_MS));
  shellBadgeSeq += 1;
  return `badge-${shellBadgeSeq}`;
});

// Identity-guard negative (loader-container-bake): a BAKE-lane loader (no
// loading() on its entry) that reads cookies(). During capture the identity
// guard throws inside the loader, wrapLoaderPromise swallows it into error UI,
// and the guard's context flag makes the capture REFUSE — deterministically,
// once-per-key warned, MISS forever. On axis 1 (and every serve) the same read
// is legal and the loader works normally.
export const ShellIdentityLoader = createLoader(async (): Promise<string> => {
  const { cookies } = await import("@rangojs/router");
  return cookies().get("session")?.value ?? "anon-visitor";
});

// Consumption-lane-rule fixtures (issue #672 / #674). Handler consumption
// (`await ctx.use(...)`) EXECUTES during PPR capture with its cookies() read
// EXEMPT from the identity guard (mirroring cache() purity semantics) — no
// refusal, the route captures. WHERE the value lands then depends on what
// shields it:
//
// - ShellSrvBadgeLoader is ALSO registered as a live-lane segment
//   (loader()+loading() on the @srvBadge parallel). The segment lane is
//   unchanged by the rule: its masked loaderData pins the slot's
//   LoaderBoundary, so the slot stays a LIVE hole (fallback frozen, value
//   fresh per serve) and the handler-computed copy is discarded with the
//   postponed subtree. seq advances per execution to pin liveness.
//   ~150ms delay mirrors ShellBadgeLoader.
// - ShellSrvChipLoader is UNREGISTERED (no loader() anywhere): consumed by
//   the LAYOUT handler and rendered straight into shell material, so the
//   capture-time value — seq AND cookie identity — BAKES into the shared
//   prelude, identical across HITs and visitors. The frozen identity is the
//   rule's documented footgun; client-side useLoader is the live lane.
const SHELL_SRV_BADGE_DELAY_MS = 150;

let shellSrvBadgeSeq = 0;

export const ShellSrvBadgeLoader = createLoader(async (): Promise<string> => {
  const { cookies } = await import("@rangojs/router");
  const visitor = cookies().get("srv_visitor")?.value ?? "anon";
  await new Promise((resolve) => setTimeout(resolve, SHELL_SRV_BADGE_DELAY_MS));
  shellSrvBadgeSeq += 1;
  return `srv-badge-${shellSrvBadgeSeq}-${visitor}`;
});

let shellSrvChipSeq = 0;

export const ShellSrvChipLoader = createLoader(async (): Promise<string> => {
  const { cookies } = await import("@rangojs/router");
  const visitor = cookies().get("srv_visitor")?.value ?? "anon";
  shellSrvChipSeq += 1;
  return `srv-chip-${shellSrvChipSeq}-${visitor}`;
});

// Shell fast-path EXECUTION MATRIX fixture (docs/design/shell-fast-path.md).
// Per-layer module counters, incremented by the exec-matrix route's middleware,
// layout handler, parallel handler, path handler, and DSL loader. The loader —
// the LIVE lane (loading() on the route) — returns a snapshot of ALL counters,
// so every serve reports which layers executed. The e2e takes two consecutive
// HITs and asserts the deltas: middleware and loader advance (live), the three
// handler counters stay frozen (replayed from the captured doc segment record,
// never executed). An SWR recapture is the documented exception — it re-runs
// handlers in a background capture — so the fixture uses a TTL long past the
// test window. The ~150ms delay keeps the loader honest real-I/O (masked at
// capture) and ensures a full tail's same-request handler increments land
// before the snapshot, so the delta assertions read cleanly either way.
const SHELL_EXEC_DELAY_MS = 150;

export interface ShellExecCounters {
  middleware: number;
  transitionWhen: number;
  layout: number;
  parallel: number;
  path: number;
  loader: number;
}

export const shellExecCounters: ShellExecCounters = {
  middleware: 0,
  transitionWhen: 0,
  layout: 0,
  parallel: 0,
  path: 0,
  loader: 0,
};

export const ShellExecLoader = createLoader(
  async (): Promise<ShellExecCounters> => {
    shellExecCounters.loader += 1;
    await new Promise((resolve) => setTimeout(resolve, SHELL_EXEC_DELAY_MS));
    return { ...shellExecCounters };
  },
);

// Slow deferred-shell-material fixture (issue #715, the storefront meta
// pattern): the layout pushes THREE top-level handle values that settle IN
// PARTS — immediate, slow (~5.5s), and a Meta CHAINED off the slow promise
// (+1s, ~6.5s total). All three are TOP-LEVEL pushes, so the capture awaits
// the COMPLETE settlement sequence (resolvedHandleStream converges only after
// every push resolves — a partial prefix is unrepresentable) and bakes the
// final values. Under a sub-settlement budget (the negative's explicit
// 1500ms) the sequence outlasts the deadline, the handles row never emits,
// SsrRoot stays suspended at the root, and the capture REFUSES (trivial
// prelude — eternal MISS + once-per-key warning). With `ppr.captureTimeout:
// 10000` (or the 15s default) the same route captures and the stored prelude
// carries all three resolved parts. A per-capture seq rides in
// each value so consecutive HITs pin frozenness (the prelude keeps the
// capture-time seq while axis-1/misses would advance it).
const SLOW_META_SLOW_DELAY_MS = 5_500;
const SLOW_META_CHAIN_EXTRA_MS = 1_000;

export interface SlowMetaParts {
  immediate: Promise<string>;
  slow: Promise<string>;
  chainedTitle: Promise<string>;
}

let slowMetaSeq = 0;

export function makeSlowMetaParts(): SlowMetaParts {
  slowMetaSeq += 1;
  const seq = slowMetaSeq;
  const immediate = Promise.resolve(`slow-meta-immediate-${seq}`);
  const slow = new Promise<string>((resolve) =>
    setTimeout(() => resolve(`slow-meta-slow-${seq}`), SLOW_META_SLOW_DELAY_MS),
  );
  // The Meta value is CHAINED off the slow push's promise with additional
  // latency — the staged-resolution shape (data -> derived meta) the capture
  // must ride to full convergence, not to the first settle.
  const chainedTitle = slow.then(
    (v) =>
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(`${v}-chained`), SLOW_META_CHAIN_EXTRA_MS),
      ),
  );
  return { immediate, slow, chainedTitle };
}

/** Handle collecting the slow fixture's non-Meta pushes for shell render. */
export const SlowMetaHandles = createHandle<string, string[]>((values) =>
  values.flat(),
);

/**
 * Render counter for the /shell-cache/outlined fixture. Fizz OUTLINES any
 * Suspense boundary over ~500 bytes (fallback written inline first, content
 * as a queued task, outline-deferred at flush), so the big section exercises
 * the outlined render + flush path end to end. Baked correctly, the section
 * renders only during capture; the count riding inside the stored prelude is
 * a capture-time snapshot by construction.
 */
export const outlinedRenderCounter: { count: number } = { count: 0 };

// Slot loader for the /shell-cache/outlined fixture's masked hole. Dedicated
// (not ShellBadgeLoader) so its seq is isolated from the slot-hole suite; the
// value advancing across HITs pins that the hole stays LIVE while the outlined
// section beside it is served from the frozen prelude.
let outlinedBadgeSeq = 0;

export const ShellOutlinedBadgeLoader = createLoader(
  async (): Promise<string> => {
    await new Promise((resolve) => setTimeout(resolve, SHELL_BADGE_DELAY_MS));
    outlinedBadgeSeq += 1;
    return `outlined-badge-${outlinedBadgeSeq}`;
  },
);

// Pin-first bake-lane fixture (loader-cache.ts `if (!recorded.holes)`). A
// bake-lane loader (registered on a layout with NO loading()) that sleeps a
// deliberately SLOW 600ms and returns a plain, HOLE-FREE container ({ label }
// — no nested promises). At capture it executes and its settled container bakes
// into the shell snapshot's loader family, hole-free. On a shell HIT the record
// is hole-free, so the HIT payload resolves the loaderData from the PIN
// immediately instead of gating on the fresh 600ms run (which still runs
// ungated for its side effects). The seq advances per execution ONLY to prove
// the served value is the pinned capture-time one — it must stay frozen across
// HITs while the fresh run keeps incrementing in the background. 600ms is well
// above the e2e's 400ms HIT bound so a gated (unoptimized) HIT visibly exceeds
// it while a pinned HIT clears it with a 200ms+ margin for CI noise.
const SHELL_BAKE_SLOW_DELAY_MS = 600;

let shellBakeSlowSeq = 0;

export const ShellBakeSlowLoader = createLoader(
  async (): Promise<{ label: string }> => {
    await new Promise((resolve) =>
      setTimeout(resolve, SHELL_BAKE_SLOW_DELAY_MS),
    );
    shellBakeSlowSeq += 1;
    return { label: `bake-${shellBakeSlowSeq}` };
  },
);

// The fast LIVE hole under the bake-slow layout: ~30ms behind loading() so the
// route has a real hole and the shell actually captures (a route with no hole
// anywhere can refuse capture). Kept far under the 600ms bake AND the 400ms HIT
// bound so it never dominates the pinned HIT's tail. Returns the ShellPriceData
// shape so the shared ShellBakeSlow component renders the same "Live price:"
// content the other fixtures assert on. seq advances every request to prove the
// hole stays live while the bake label is pinned.
const SHELL_BAKE_HOLE_DELAY_MS = 30;

let shellBakeHoleSeq = 0;

export const ShellBakeHoleLoader = createLoader(
  async (): Promise<ShellPriceData> => {
    await new Promise((resolve) =>
      setTimeout(resolve, SHELL_BAKE_HOLE_DELAY_MS),
    );
    shellBakeHoleSeq += 1;
    return { price: 42, seq: shellBakeHoleSeq, loadedAt: Date.now() };
  },
);
