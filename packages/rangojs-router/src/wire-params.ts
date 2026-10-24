/**
 * The router's `_rsc_*` query parameter names, shared by the browser and the
 * server graph (dependency free): the one module that spells them
 * (tools/check-internals.mjs rule rsc-param-literal). The browser writes the
 * partial-request set through browser/wire-protocol.ts writePartialParams.
 */
export const WIRE = {
  /** A navigation or prefetch: `true`. */
  partial: "_rsc_partial",
  /** The mounted segment ids, comma-joined. */
  segments: "_rsc_segments",
  /** A JS server action's id, in place of `partial`. */
  action: "_rsc_action",
  /** The client's build version (version-mismatch reload). */
  version: "_rsc_v",
  /** The client's router id (app-switch reload). */
  routerId: "_rsc_rid",
  /** The rewrite target of the page on screen (#1144). */
  rewriteTarget: "_rsc_rt",
  /** A stale request: `true` (router/navigation-snapshot.ts). */
  stale: "_rsc_stale",
  /** A fill request (docs/design/prefetch-false.md): `1`. */
  fill: "_rsc_fill",
  /** A loader fetch's loader id (rsc/loader-fetch.ts). */
  loader: "_rsc_loader",
  /** A loader fetch's params, JSON: a query param, or a form field on a POST. */
  loaderParams: "_rsc_loader_params",
  /** The forced-MISS marker of a degraded PPR shell reload (rsc/shell-serve.ts). */
  shellMiss: "_rsc_shell",
  /** A connection warmup HEAD request (browser/connection-warmup.ts). */
  warmup: "_rsc_warmup",
} as const;

/** The prefix every name in WIRE starts with. */
export const WIRE_PREFIX = "_rsc_";
