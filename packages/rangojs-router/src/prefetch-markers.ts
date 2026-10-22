/**
 * The wire markers of prefetches, of `prefetch: false`
 * (docs/design/prefetch-false.md) and of stale requests: shared by the browser
 * and the server (router/segment-resolution/prefetch-deferral.ts requestKind,
 * rsc/prefetch-render-error.ts, rsc/rsc-rendering.ts,
 * cache/document-cache.ts, router/navigation-snapshot.ts). Dependency free,
 * like segment-fragments.ts: the browser must not import the server modules
 * that use them.
 */

/** Request header of a `<Link>` prefetch (browser/prefetch/fetch.ts). */
export const PREFETCH_HEADER = "X-Rango-Prefetch";

/** Query param of a fill request (browser/navigation-client.ts). */
export const FILL_PARAM = "_rsc_fill";

/**
 * Query param of a stale request (browser/navigation-client.ts): `revalidate()`
 * sees `stale: true` (router/navigation-snapshot.ts).
 */
export const STALE_PARAM = "_rsc_stale";

/**
 * The last row of a prefetch whose render reported an error
 * (rsc/prefetch-render-error.ts): a Flight hint with a code React does not
 * dispatch, so the decoder skips it (pinned by
 * src/__tests__/flight-unknown-hint.test.ts), and browser/response-adapter.ts
 * reads the stream as not ended cleanly. Five bytes: teeWithCompletion keeps
 * the last five.
 */
export const PREFETCH_FAILED_ROW = ":H_0\n";
