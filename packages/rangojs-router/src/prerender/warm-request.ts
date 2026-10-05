/**
 * The mark and record of a `router.prerender()` warm request
 * (docs/design/prerender-every-route.md, "The synthetic request"). The
 * trigger marks the `Request` it dispatches, the handler puts the record on
 * the request context (`RequestContext._prerenderWarm`), and each cache layer
 * reads the context where it reads its store. No runtime imports: the cache
 * layers import this without pulling the trigger.
 */

import type { HandlerCacheConfig } from "../rsc/types.js";
import type { ShellCaptureDebugEvent } from "../rsc/shell-capture.js";
import type { PrerenderWarmCaches } from "./on-demand.js";

/** What one warm request did: written by the layers, read by the trigger. */
export interface PrerenderWarmRecord extends PrerenderWarmCaches {
  /**
   * `replace`: every runtime cache read misses and the writes replace the
   * entries. `fill` (`onlyIfStale`): reads are normal; the record only reports.
   */
  mode: "replace" | "fill";
  /**
   * The `createRouter({ cache })` config the trigger gated on its scope. The
   * handler uses it instead of resolving the option again, so the store that
   * was checked is the store that is written.
   */
  cacheConfig: HandlerCacheConfig;
  /** The surface an identity guard refused (server/context.ts guardIdentityRead). */
  identity?: string;
  /** The request's `RequestContext._renderErrors`, set by the handler. */
  renderErrors?: unknown[];
}

/** What the helpers read; a derived capture context inherits the record. */
interface WarmContext {
  _prerenderWarm?: PrerenderWarmRecord;
  _shellCaptureRun?: boolean;
}

/**
 * In process on purpose: "miss every cache and overwrite it" reachable from a
 * URL parameter, header or cookie would be a cache-busting amplifier. A client
 * controls the bytes of a request, never this map's keys.
 */
const warmRequests = new WeakMap<Request, PrerenderWarmRecord>();

export function createWarmRecord(
  mode: PrerenderWarmRecord["mode"],
  cacheConfig: HandlerCacheConfig,
): PrerenderWarmRecord {
  return {
    mode,
    cacheConfig,
    writes: { record: 0, item: 0, response: 0, shell: 0 },
  };
}

/** The mark is the object: a clone or a rebuilt request carries none. */
export function markWarmRequest(
  request: Request,
  record: PrerenderWarmRecord,
): void {
  warmRequests.set(request, record);
}

export function readWarmMark(
  request: Request,
): PrerenderWarmRecord | undefined {
  return warmRequests.get(request);
}

/**
 * True when this request must read every runtime cache as a miss. False in
 * the warm's own shell capture (`_shellCaptureRun`): it runs after the warm's
 * writes settled and must replay them, or it would render every handler a
 * second time and could bake another generation than the one just written.
 */
export function isWarmReplace(ctx: WarmContext | null | undefined): boolean {
  return (
    ctx?._prerenderWarm?.mode === "replace" && ctx._shellCaptureRun !== true
  );
}

/** Count a store write that landed. No-op outside a warm. */
export function noteWarmWrite(
  ctx: WarmContext | null | undefined,
  family: keyof PrerenderWarmCaches["writes"],
): void {
  const record = ctx?._prerenderWarm;
  if (record) record.writes[family] += 1;
}

/** Record the document cache's outcome; `stored` is also a response write. */
export function noteWarmDocument(
  ctx: WarmContext | null | undefined,
  outcome: NonNullable<PrerenderWarmCaches["document"]>,
): void {
  const record = ctx?._prerenderWarm;
  if (!record) return;
  record.document = outcome;
  if (outcome === "stored") record.writes.response += 1;
}

/** Record the surface an identity guard (guardIdentityRead) is about to refuse. */
export function noteWarmIdentityRead(ctx: unknown, surface: string): void {
  const record = (ctx as WarmContext | null | undefined)?._prerenderWarm;
  if (record) record.identity ??= surface;
}

const SHELL_EVENT_OUTCOMES: Partial<
  Record<
    ShellCaptureDebugEvent["outcome"],
    NonNullable<PrerenderWarmCaches["shell"]>
  >
> = {
  stored: "stored",
  refused: "refused",
  "no-shell": "no-shell",
  expired: "no-shell",
  redirect: "no-shell",
  error: "error",
  "skip-capacity": "skipped-capacity",
  "skip-queue-timeout": "skipped-queue-timeout",
  "skip-inert-store": "not-eligible",
};

/**
 * Fold one capture event into the record: the last attempt's outcome stands.
 * The skips a forced capture never takes and the `backoff` notice leave it.
 */
export function noteWarmShellEvent(
  record: PrerenderWarmRecord,
  event: ShellCaptureDebugEvent,
): void {
  let shell = SHELL_EVENT_OUTCOMES[event.outcome];
  if (shell === undefined) return;
  // A putShell that threw still ends the attempt `stored` (the capture
  // worked; shell-capture.ts reports the I/O error), but counted no write.
  if (shell === "stored" && record.writes.shell === 0) shell = "error";
  record.shell = shell;
  if (shell === "stored") delete record.refusal;
  else if (event.refusal !== undefined) record.refusal = event.refusal;
}
