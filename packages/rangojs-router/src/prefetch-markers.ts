/**
 * The wire markers of prefetches: shared by the browser and the server
 * (router/segment-resolution/prefetch-deferral.ts requestKind,
 * rsc/prefetch-render-error.ts, rsc/rsc-rendering.ts). Dependency free, like
 * segment-fragments.ts: the browser must not import the server modules that
 * use them.
 */

/** Request header of a `<Link>` prefetch (browser/prefetch/fetch.ts). */
export const PREFETCH_HEADER = "X-Rango-Prefetch";

/**
 * PREFETCH_HEADER's value on an intent prefetch: a hover or an explicit
 * `prefetch()` call (browser/prefetch/fetch.ts prefetchDirect). The server
 * runs the work flagged `prefetch: "intent"` in it and defers the work
 * flagged `prefetch: false`. A speculative prefetch (viewport, render) sends
 * `1` and defers both; any value other than this one reads as speculative.
 */
export const PREFETCH_INTENT = "intent";

/**
 * A recorded `prefetch` flag of loader() or loading(): `false` defers the
 * work in every prefetch, `"intent"` in a speculative one only
 * (router/segment-resolution/prefetch-deferral.ts).
 */
export type PrefetchFlag = false | typeof PREFETCH_INTENT;

/** A `prefetch` DSL option as written: a boolean, or `"intent"`. */
export type PrefetchOption = boolean | PrefetchFlag;

/** The option asks for deferral: `prefetch: false` or `prefetch: "intent"`. */
export function isPrefetchFlag(value: unknown): value is PrefetchFlag {
  return value === false || value === PREFETCH_INTENT;
}

/**
 * The last row of a prefetch whose render reported an error
 * (rsc/prefetch-render-error.ts): a Flight hint with a code React does not
 * dispatch, so the decoder skips it (pinned by
 * src/__tests__/flight-unknown-hint.test.ts), and browser/response-adapter.ts
 * reads the stream as not ended cleanly. Five bytes: teeWithCompletion keeps
 * the last five.
 */
export const PREFETCH_FAILED_ROW = ":H_0\n";
