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
  kind: "baked" | "nested";
  value?: string;
  pending?: Promise<string>;
}

export const ShellHandles = createHandle<ShellHandleItem, ShellHandleItem[]>(
  (values) => values.flat(),
);

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
