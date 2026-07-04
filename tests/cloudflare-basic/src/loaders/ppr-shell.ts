import { createLoader } from "@rangojs/router";

// Physics fixture: a handler-created promise passed as a PROP to a client
// component that use()s it under its own <Suspense>. Genuinely pending real I/O
// (~250ms) cannot win the capture's task-quantized quiet window, so the boundary
// postpones — a HOLE by physics, not by registration. Deterministic value (no
// drift; the resumed HTML and hydration payload come from the same tail render).
const PPR_PHYSICS_DELAY_MS = 250;

export function makePprPhysicsPromise(): Promise<string> {
  return new Promise((resolve) =>
    setTimeout(() => resolve("PHYSICS-HOLE-VALUE"), PPR_PHYSICS_DELAY_MS),
  );
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
