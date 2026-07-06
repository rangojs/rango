import { createLoader, cacheTag } from "@rangojs/router";

// Mutable module state for the PPR action e2e (Deliverable 10). Kept in a plain,
// directive-free module (mirrors cart-store.ts) so the loader reads it by identity
// and the "use server" actions mutate it without a TDZ race.

// --- HOLE data: loader-fed, live on every request (10a / 10c) ---

let holeCounter = 0;
export function getHoleCounter(): number {
  return holeCounter;
}
export function bumpHoleCounter(): number {
  holeCounter += 1;
  return holeCounter;
}

export interface ShellActionCounterData {
  count: number;
  seq: number;
  loadedAt: number;
}

let counterLoaderSeq = 0;
const HOLE_LOADER_DELAY_MS = 400;

// The hole: a ~400ms loader reading mutable module state. Masked at capture (so the
// route postpones behind loading()), fresh on every serve — so an action that
// mutates holeCounter shows up on the next GET with NO invalidation (loaders are
// live under PPR). `seq` advances every run to prove the hole is re-executed.
export const ShellActionCounterLoader = createLoader(
  async (): Promise<ShellActionCounterData> => {
    await new Promise((r) => setTimeout(r, HOLE_LOADER_DELAY_MS));
    counterLoaderSeq += 1;
    return {
      count: getHoleCounter(),
      seq: counterLoaderSeq,
      loadedAt: Date.now(),
    };
  },
);

// --- SHELL material: cached + tagged, frozen into the prelude (10b) ---

export const SHELL_ACTION_BANNER_TAG = "ppr-shell-action-banner";

let bannerVersion = 1;
let bannerText = "Banner v1";
// Monotonic bump so each shell mutation is provably distinct (Banner v1 -> v2 ...),
// which makes the recaptured-shell assertion robust across Playwright retries.
export function bumpBanner(): string {
  bannerVersion += 1;
  bannerText = `Banner v${bannerVersion}`;
  return bannerText;
}

// --- PE (no-JS) marker: SHELL-visible, so a native POST is observable without JS
// (a Suspense-holed value would sit in a hidden <template> that needs JS to reveal).
// It reads "none" until a PE POST fires, so on any GET (capture included) it is the
// constant "none" — no drift, no hydration warning for the JS tests on this route.

let lastPeSubmit = "none";
let peSubmitCount = 0;
export function getLastPeSubmit(): string {
  return lastPeSubmit;
}
export function markPeSubmit(): string {
  peSubmitCount += 1;
  lastPeSubmit = `pe-${peSubmitCount}`;
  return lastPeSubmit;
}

// Cached, tagged shell material read in the LAYOUT (frozen into the prelude). The
// capture render runs this (it is shell material, NOT a masked loader), so cacheTag
// records SHELL_ACTION_BANNER_TAG on the capture's request tags and the shell entry
// auto-carries it. updateTag(SHELL_ACTION_BANNER_TAG) then drops BOTH the cached
// value AND the shell → the next GET MISSes and recaptures with the new banner in
// the prelude. This is the write-path loop end-to-end.
export async function getShellActionBanner(): Promise<string> {
  "use cache";
  cacheTag(SHELL_ACTION_BANNER_TAG);
  return bannerText;
}
