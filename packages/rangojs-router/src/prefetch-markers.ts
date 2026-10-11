/**
 * The wire markers of `prefetch: false` (docs/design/prefetch-false.md):
 * shared by the browser that sends them and the server that reads them
 * (router/segment-resolution/prefetch-deferral.ts requestKind). Dependency
 * free, like segment-fragments.ts: the browser must not import the server
 * module that reads them.
 */

/** Request header of a `<Link>` prefetch (browser/prefetch/fetch.ts). */
export const PREFETCH_HEADER = "X-Rango-Prefetch";

/** Query param of a fill request (browser/navigation-client.ts). */
export const FILL_PARAM = "_rsc_fill";
