import { createHandle } from "@rangojs/router";

// Deferred-shell-material fixtures (issue #715, the storefront meta pattern):
// TOP-LEVEL handle pushes settling IN PARTS — an immediate part, a slow part,
// and a Meta title CHAINED off the slow promise with extra latency. The
// capture awaits the COMPLETE settlement sequence (a partial prefix is
// unrepresentable: SsrRoot suspends at the root until the final resolved
// snapshot) and bakes the final values into the stored prelude.
//
// Two variants share the shape and differ only in tempo, so the SLOW one
// (~6.5s, needs `ppr.captureTimeout: 10000`) proves the budget admits staged
// material past the 5s default, while the SHORT one (~3.5s against an
// explicit 1500ms budget) pins the refusal semantics — budget expires with
// pushes pending -> capture REFUSES, never a partial bake — without parking
// the worker's serialized capture queue behind two 5s default-budget attempts
// (this suite shares one worker across all ppr tests; see capture-queue.ts).
// The no-knob default-budget negative runs in the router's own test-app suite
// (isolated server), not here.
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
