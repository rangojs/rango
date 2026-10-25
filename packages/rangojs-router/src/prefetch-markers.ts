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
 * The last row of a prefetch whose render reported an error
 * (rsc/prefetch-render-error.ts): a Flight hint with a code React does not
 * dispatch, so the decoder skips it (pinned by
 * src/__tests__/flight-unknown-hint.test.ts), and browser/response-adapter.ts
 * reads the stream as not ended cleanly. Five bytes: teeWithCompletion keeps
 * the last five.
 */
export const PREFETCH_FAILED_ROW = ":H_0\n";
