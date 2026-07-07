import { createHandle } from "@rangojs/router";

// Deferred-shell-material fixtures (issue #715, the storefront meta pattern):
// TOP-LEVEL handle pushes settling IN PARTS — an immediate part, a slow part,
// and a Meta title CHAINED off the slow promise with extra latency. The
// capture awaits the COMPLETE settlement sequence (a partial prefix is
// unrepresentable: SsrRoot suspends at the root until the final resolved
// snapshot) and bakes the final values into the stored prelude.
//
// Two variants share the shape and differ only in tempo, so the SLOW one
// (~6.5s under `ppr.captureTimeout: 10000`) proves a declared budget admits
// staged material, while the SHORT one (~3.5s against an explicit 1500ms
// budget) pins the refusal semantics — budget expires with pushes pending ->
// capture REFUSES, never a partial bake. The short tempo keeps the worker's
// serialized capture queue clear (this suite shares one worker across all
// ppr tests; see capture-queue.ts). No suite runs a no-knob refusal: the 15s
// default ADMITS both tempos, and refusing it would need >15s material and
// ~30s waits — the default VALUE is pinned by the router's shell-capture
// unit test; refusal coverage is explicit-budget here and in the router
// test-app's slow-meta-default.
const SLOW_META_SLOW_DELAY_MS = 5_500;
const SLOW_META_CHAIN_EXTRA_MS = 1_000;
const SHORT_META_SLOW_DELAY_MS = 2_500;
const SHORT_META_CHAIN_EXTRA_MS = 1_000;

export interface PprSlowMetaParts {
  immediate: Promise<string>;
  slow: Promise<string>;
  chainedTitle: Promise<string>;
}

let slowMetaSeq = 0;

function makeParts(
  prefix: string,
  slowDelayMs: number,
  chainExtraMs: number,
): PprSlowMetaParts {
  slowMetaSeq += 1;
  const seq = slowMetaSeq;
  const immediate = Promise.resolve(`${prefix}-immediate-${seq}`);
  const slow = new Promise<string>((resolve) =>
    setTimeout(() => resolve(`${prefix}-slow-${seq}`), slowDelayMs),
  );
  // Chained off the slow push's promise: staged resolution (data -> derived
  // meta) — the capture must ride to FULL convergence, not the first settle.
  const chainedTitle = slow.then(
    (v) =>
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(`${v}-chained`), chainExtraMs),
      ),
  );
  return { immediate, slow, chainedTitle };
}

export function makePprSlowMetaParts(): PprSlowMetaParts {
  return makeParts(
    "ppr-slow-meta",
    SLOW_META_SLOW_DELAY_MS,
    SLOW_META_CHAIN_EXTRA_MS,
  );
}

export function makePprShortMetaParts(): PprSlowMetaParts {
  return makeParts(
    "ppr-short-meta",
    SHORT_META_SLOW_DELAY_MS,
    SHORT_META_CHAIN_EXTRA_MS,
  );
}

/** Handle collecting the fixtures' non-Meta pushes for shell render. */
export const PprSlowMetaHandles = createHandle<string, string[]>((values) =>
  values.flat(),
);
