import { createHandle, createLoader } from "@rangojs/router";

// Handler-promise fixture: a handler-created promise (~250ms) passed as a
// PROP to a client component that use()s it under its own <Suspense>. It is
// handler output: the PPR capture waits for it and bakes the value into the
// prelude, and every HIT replays it (the "PHYSICS" token is historical: this
// used to be a hole). Deterministic value.
const PPR_PHYSICS_DELAY_MS = 250;

export function makePprPhysicsPromise(): Promise<string> {
  return new Promise((resolve) =>
    setTimeout(() => resolve("PHYSICS-HOLE-VALUE"), PPR_PHYSICS_DELAY_MS),
  );
}

// Nested handle push fixture: PprShellLayout pushes a container whose
// `value` is a pending promise (~200ms). Handler output: the capture waits for
// the nested promise and bakes it (a DSL loader's nested push would stay
// live).
export interface PprNestedHandleItem {
  label: string;
  value: Promise<string>;
}

export const PprNestedHandle = createHandle<
  PprNestedHandleItem,
  PprNestedHandleItem[]
>((values) => values.flat());

export function makePprNestedHandlePush(): PprNestedHandleItem {
  return {
    label: "nested",
    value: new Promise((resolve) =>
      setTimeout(() => resolve("NESTED-HANDLE-VALUE"), 200),
    ),
  };
}

// The live hole under the frozen PPR shell (docs/design/ppr-shell-resume.md).
// A ~400ms loader whose seq advances on EVERY request: it proves loaders stay
// fresh (the hole is re-run per request) while the shell prelude is served from
// cache. During shell capture the loader is masked, so this subtree postpones and
// becomes the hole; on serve it runs fresh and resumes into the frozen shell.
const PPR_SHELL_LOADER_DELAY_MS = 400;

export interface PprShellPriceData {
  price: number;
  seq: number;
  loadedAt: number;
}

let pprPriceSeq = 0;

export const PprShellPriceLoader = createLoader(
  async (): Promise<PprShellPriceData> => {
    await new Promise((resolve) =>
      setTimeout(resolve, PPR_SHELL_LOADER_DELAY_MS),
    );
    pprPriceSeq += 1;
    return { price: 42, seq: pprPriceSeq, loadedAt: Date.now() };
  },
);

// Loader-carried promise: the deterministic streaming lane under a PPR hole
// (docs/design/ppr-shell-resume.md). The loader resolves its OUTER value fast
// but carries a NESTED promise that settles ~300ms later. FlightSerialize
// preserves the nested Promise (src/serialize.ts), so the client use()s it under
// its OWN inner Suspense — a second streaming layer INSIDE the loader hole.
//
// Two routes share this one loader to pin the whole contract:
//   /ppr-shell/stream   (WITH loading()) -> the loading() boundary is the hole;
//                        on a HIT the resume streams three layers in one body:
//                        cached shell -> outer + inner fallback -> inner content.
//   /ppr-shell/no-hole  (NO loading())  -> capture refuses (masked loader pins
//                        the tree-build await), so x-rango-shell stays MISS
//                        forever; the inner promise STILL streams under axis 1.
//                        No loading() degrades only the caching, never the route.
const PPR_STREAM_INNER_DELAY_MS = 300;

export interface PprShellStreamData {
  label: string;
  // Nested promise: settles after the outer value, streamed under an inner
  // Suspense on the client.
  pendingData: Promise<string>;
}

let pprStreamSeq = 0;

export const PprShellStreamLoader = createLoader(
  async (): Promise<PprShellStreamData> => {
    pprStreamSeq += 1;
    const seq = pprStreamSeq;
    const pendingData = new Promise<string>((resolve) =>
      setTimeout(
        () => resolve(`Streamed inner ${seq}`),
        PPR_STREAM_INNER_DELAY_MS,
      ),
    );
    // seq in the label makes the CONTAINER per-execution distinguishable, so
    // the bake-lane e2e can pin the snapshot overlay (outer seq frozen across
    // HITs) against the live nested lane (inner seq advancing).
    return { label: `Streamed outer ${seq}`, pendingData };
  },
);

const PPR_INLINE_ACTION_WARM_HOLE_DELAY_MS = 2_000;
const PPR_INLINE_ACTION_HOLE_FAILSAFE_MS = 30_000;
const PPR_INLINE_ACTION_HOLE_AFTER_ACTION_MS = 2_000;

// Probe-scoped resolvers make the ordering causal: the page hole cannot finish
// until this page's action result has streamed. The long timer is only a leak
// failsafe; API warm-up requests opt into the short timer via a test header.
const pprInlineActionHoleResolvers = new Map<string, Set<() => void>>();

export function resolvePprInlineActionHoleAfterAction(probe: string): void {
  setTimeout(() => {
    for (const resolve of [
      ...(pprInlineActionHoleResolvers.get(probe) ?? []),
    ]) {
      resolve();
    }
  }, PPR_INLINE_ACTION_HOLE_AFTER_ACTION_MS);
}

export interface PprInlineActionHoleData {
  pendingData: Promise<string>;
}

// Bake-lane container with a nested promise: the form remains shell material,
// while the nested value is masked during capture and streams fresh per serve.
export const PprInlineActionHoleLoader = createLoader(
  async (ctx): Promise<PprInlineActionHoleData> => {
    const probe = ctx.searchParams.get("probe") ?? "default";
    const resolvers = pprInlineActionHoleResolvers.get(probe) ?? new Set();
    pprInlineActionHoleResolvers.set(probe, resolvers);
    const pendingData = new Promise<string>((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timeout);
        resolvers.delete(finish);
        if (resolvers.size === 0) pprInlineActionHoleResolvers.delete(probe);
        resolve("CF page hole resolved");
      };
      resolvers.add(finish);
      timeout = setTimeout(
        finish,
        ctx.request.headers.has("x-rango-test-short-inline-hole")
          ? PPR_INLINE_ACTION_WARM_HOLE_DELAY_MS
          : PPR_INLINE_ACTION_HOLE_FAILSAFE_MS,
      );
    });
    return { pendingData };
  },
);

// Layout-loader bake-lane fixture (the storefront shape: an app-wide layout
// registering session/basket-style loaders, no loading() on the layout).
// Executes at capture (the gate holds for the 100ms), bakes, and is
// snapshot-pinned on HITs. Consumed by nothing — the lane decision is
// registration-level, not consumption-level.
const PPR_CHROME_DELAY_MS = 100;

let pprChromeSeq = 0;

export const PprChromeLoader = createLoader(async (): Promise<string> => {
  await new Promise((resolve) => setTimeout(resolve, PPR_CHROME_DELAY_MS));
  pprChromeSeq += 1;
  return `chrome-${pprChromeSeq}`;
});

// Slot live-lane fixture: the SAME chrome-data shape as PprChromeLoader, but
// owned by a @badge parallel slot with its own loading() — masked at capture,
// GUARANTEED fresh per serve (where the bake lane would pin it). seq advances
// on every execution to prove the badge stays live across shell HITs.
const PPR_BADGE_DELAY_MS = 150;

let pprBadgeSeq = 0;

export const PprBadgeLoader = createLoader(async (): Promise<string> => {
  await new Promise((resolve) => setTimeout(resolve, PPR_BADGE_DELAY_MS));
  pprBadgeSeq += 1;
  return `badge-${pprBadgeSeq}`;
});

// Settled-marker regression fixture (the storefront PDP React #438): a
// bake-lane loader whose nested promise is ALREADY RESOLVED when the container
// returns. It always wins the capture window, so the snapshot pins its VALUE —
// wrapped in the settled marker, which the HIT overlay must rehydrate into
// Promise.resolve(value): the client consumer calls use(data.fast)
// unconditionally, and a raw value there threw #438 and the root error
// boundary replaced the whole page.
export interface PprShellSettledData {
  label: string;
  fast: Promise<string>;
}

let pprSettledSeq = 0;

export const PprShellSettledLoader = createLoader(
  async (): Promise<PprShellSettledData> => {
    pprSettledSeq += 1;
    return {
      label: `Settled outer ${pprSettledSeq}`,
      fast: Promise.resolve(`Settled fast ${pprSettledSeq}`),
    };
  },
);

export interface PprStaleReplayHandleValue {
  yo?: string;
  asd?: string;
}

export const PprStaleReplayHandle = createHandle<PprStaleReplayHandleValue>();

let pprStaleReplayExecutions = 0;

export function makePprStaleReplayData(id: string): Promise<string> {
  pprStaleReplayExecutions += 1;
  const execution = pprStaleReplayExecutions;
  return new Promise((resolve) =>
    setTimeout(() => resolve(`ppr-stale-${id}-execution-${execution}`), 1_500),
  );
}

// Issue #888 fixture: a string handle pushed by an unflagged loader that an
// ssr:false loader awaits. Both run at capture and neither runs on a HIT (the
// promise-free ssr:false loader is served from the shell), so the doc record
// keeps the push and the HIT restores it once. Default (identity) collect: a
// duplicate push shows up as a second value.
export const PprWarnings = createHandle<string>();

/**
 * Body runs of the /ppr-warnings loaders. A HIT runs neither: the
 * promise-free bake-lane loader is served from the shell, and the loader it
 * awaits with it.
 */
export const pprStorefrontRuns = { storefront: 0, stock: 0 };

export const PprStockLoader = createLoader(async (ctx) => {
  pprStorefrontRuns.stock += 1;
  ctx.use(PprWarnings)("Low stock");
  return { lowStock: true };
});

export const PprStorefrontLoader = createLoader(async (ctx) => {
  pprStorefrontRuns.storefront += 1;
  const stock = await ctx.use(PprStockLoader);
  return { lowStock: stock.lowStock };
});

/** Body runs of the /ppr-nav-pin bake-lane loader. */
export const pprNavPinRuns = { baked: 0 };

/**
 * A promise-free ssr:false loader on an entry with loading(): served from the
 * shell, without running, on a document HIT and on a client navigation that
 * replays the shell.
 */
export const PprNavPinLoader = createLoader(async () => {
  pprNavPinRuns.baked += 1;
  return { baked: `nav-pin-baked-${pprNavPinRuns.baked}` };
});

// Issue #929 fixture: the ssr:false loader pushes the string handle itself.
// The doc record keeps the push (the prelude rendered it) and the HIT, which
// does not run the promise-free loader, restores it once.
export const PprRestockLoader = createLoader(async (ctx) => {
  ctx.use(PprWarnings)("Restock soon");
  return { restock: true };
});

// Issue #927: a bake-lane value Flight encodes cleanly on its first pass and
// with an error row on its second. The capture renders one loader run's value
// (pass 1), then the snapshot re-encodes it (pass 2); the foreground render
// encodes its own run once. A Map is a leaf to the capture's mask and elide
// walks, so both passes iterate this instance. Fails once per ?run=, so a
// later capture stores.
const pprFlightErrorRuns = new Set<string>();

/**
 * Most passes any one PprFlightErrorLoader value took, per ?run=. The
 * capture's value takes 2; any other count means the pass-2 failure no longer
 * lands on the snapshot encode.
 */
export const pprFlightErrorPasses: Map<string, number> = new Map();

class PprRelatedEntries extends Map<string, unknown> {
  private passes = 0;

  constructor(private readonly run: string) {
    super([["related", "related ok"]]);
  }

  override *[Symbol.iterator](): MapIterator<[string, unknown]> {
    this.passes += 1;
    pprFlightErrorPasses.set(
      this.run,
      Math.max(pprFlightErrorPasses.get(this.run) ?? 0, this.passes),
    );
    if (this.passes === 2 && !pprFlightErrorRuns.has(this.run)) {
      pprFlightErrorRuns.add(this.run);
      const failed = Promise.reject(new Error("related upstream down"));
      failed.catch(() => {});
      yield ["related", failed];
      return;
    }
    yield* super.entries();
  }
}

export const PprFlightErrorLoader = createLoader(async (ctx) => ({
  entries: new PprRelatedEntries(ctx.url.searchParams.get("run") ?? ""),
}));

// Shell fast-path EXECUTION MATRIX fixture (docs/design/shell-fast-path.md),
// the workerd/KV counterpart of test-app's shell-cache exec matrix. Per-layer
// module counters; the DSL loader (live lane) reports the snapshot per serve,
// so two consecutive HITs expose which layers executed in between: middleware
// and loader advance, the three handler counters stay frozen (replayed from
// the captured doc segment record). Module state persists per isolate, the
// same mechanism the seq-based liveness fixtures above rely on.
const PPR_EXEC_DELAY_MS = 150;

export interface PprExecCounters {
  middleware: number;
  layout: number;
  parallel: number;
  path: number;
  loader: number;
}

export const pprExecCounters: PprExecCounters = {
  middleware: 0,
  layout: 0,
  parallel: 0,
  path: 0,
  loader: 0,
};

export const PprShellExecLoader = createLoader(
  async (): Promise<PprExecCounters> => {
    pprExecCounters.loader += 1;
    await new Promise((resolve) => setTimeout(resolve, PPR_EXEC_DELAY_MS));
    return { ...pprExecCounters };
  },
);

// Pin-first bake-lane fixture (loader-cache.ts `if (!recorded.holes)`), the
// workerd/KV counterpart of test-app's bake-slow. A bake-lane loader (registered
// on a layout with NO loading()) that sleeps a deliberately SLOW 600ms and
// returns a plain, HOLE-FREE container ({ label } — no nested promises). At
// capture it executes and its settled container bakes into the shell snapshot's
// loader family, hole-free. On a shell HIT the record is hole-free, so the HIT
// payload resolves the loaderData from the PIN immediately instead of gating on
// the fresh 600ms run (which still runs ungated for its side effects). seq
// advances per execution only to prove the served value is the pinned
// capture-time one — frozen across HITs while the fresh run keeps incrementing.
// 600ms is well above the e2e's 400ms HIT bound so a gated (unoptimized) HIT
// visibly exceeds it while a pinned HIT clears it with a 200ms+ margin.
const PPR_BAKE_SLOW_DELAY_MS = 600;

let pprBakeSlowSeq = 0;

export const PprBakeSlowLoader = createLoader(
  async (): Promise<{ label: string }> => {
    await new Promise((resolve) => setTimeout(resolve, PPR_BAKE_SLOW_DELAY_MS));
    pprBakeSlowSeq += 1;
    return { label: `bake-${pprBakeSlowSeq}` };
  },
);

// The fast LIVE hole under the bake-slow layout: ~30ms behind loading() so the
// route has a real hole and the shell actually captures (a route with no hole
// anywhere can refuse capture). Kept far under the 600ms bake AND the 400ms HIT
// bound so it never dominates the pinned HIT's tail. Returns the
// PprShellPriceData shape so the shared PprBakeSlow view renders the same "Live
// price:" content the other fixtures assert on; seq advances every request to
// prove the hole stays live while the bake label is pinned.
const PPR_BAKE_HOLE_DELAY_MS = 30;

let pprBakeHoleSeq = 0;

export const PprBakeHoleLoader = createLoader(
  async (): Promise<PprShellPriceData> => {
    await new Promise((resolve) => setTimeout(resolve, PPR_BAKE_HOLE_DELAY_MS));
    pprBakeHoleSeq += 1;
    return { price: 42, seq: pprBakeHoleSeq, loadedAt: Date.now() };
  },
);

// Prerender + ppr composition fixture (docs/design/shell-fast-path.md): the
// live loader owned by the @ppSeq slot on the prerendered ppr route. seq
// advances per execution to pin slot-hole liveness while the build-time
// segments replay as the frozen shell.
let pprPrerenderSeq = 0;

export const PprPrerenderSeqLoader = createLoader(
  async (): Promise<{ seq: number }> => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    pprPrerenderSeq += 1;
    return { seq: pprPrerenderSeq };
  },
);
