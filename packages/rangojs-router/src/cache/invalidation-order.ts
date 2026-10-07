/**
 * The isolate's order of tag invalidations and cache execution starts
 * (#973, #977): what the write gate in tag-invalidation.ts
 * (predatesInvalidation) and the "use cache" join check read to tell whether
 * an execution's value may predate an invalidation of one of its tags.
 * Imports nothing, so request-context.ts can take each request's start here
 * without a cycle through tag-invalidation.ts.
 *
 * - `seq` (#973): a counter, not Date.now(). Workers advance the clock only
 *   on I/O, so an execution started right after an invalidation would share
 *   its millisecond and read as older.
 * - `tags` (#977): tag -> the `seq` of its latest invalidation, from every
 *   request, oldest first. Bounded: dropping the oldest raises `forgotten`,
 *   and an execution that started before a forgotten invalidation counts as
 *   invalidated, whatever its tags (a miss, never a stale read).
 *
 * Keyed by tag name alone, not by router or store: two routers in one
 * isolate that share a tag name skip each other's writes started before an
 * invalidation. That costs a miss, never a stale read.
 *
 * On globalThis: a second evaluated copy of this module (a duplicated
 * package, a dev re-evaluation) must read the invalidations the first one
 * recorded, or its writers pass the gate.
 */
interface IsolateOrder {
  seq: number;
  tags: Map<string, number>;
  forgotten: number;
}
const order: IsolateOrder = ((globalThis as any)[
  Symbol.for("rangojs-router:tag-invalidation-order")
] ??= { seq: 0, tags: new Map(), forgotten: 0 });
const ISOLATE_INVALIDATION_HISTORY = 1024;

/**
 * Where a cache execution ("use cache", a loader's own cache(), a route
 * cache() render, a request's document) started: its position in this
 * isolate's order, and the store clock for invalidations this isolate did
 * not see.
 */
export interface ExecutionStart {
  readonly seq: number;
  readonly at: number;
}

/**
 * The `taggedAt` / `ta` stamp a store writes on a tagged data entry: the start
 * of the execution that produced the value (`startedAt`), so a marker written
 * while it ran rejects the entry on read (#1068). Write time when the writer
 * knows no start. Never later than now: a start from a skewed clock must not
 * stamp the future, which would make the entry look newer than every marker.
 */
export function entryStamp(startedAt: number | undefined): number {
  const now = Date.now();
  // 0 is "no start", not the epoch: no marker is older than it, so such an
  // entry would never be rejected.
  return typeof startedAt === "number" &&
    Number.isFinite(startedAt) &&
    startedAt > 0
    ? Math.min(startedAt, now)
    : now;
}

/** The stamp of a data entry: `entryStamp` for a tagged entry, none otherwise. */
export function taggedStamp(
  tags: readonly string[] | undefined,
  startedAt: number | undefined,
): number | undefined {
  return Array.isArray(tags) && tags.length > 0
    ? entryStamp(startedAt)
    : undefined;
}

/**
 * putResponse has no options object to carry the start and takes no new
 * positional parameter, so the writer marks the Response it hands over.
 * On globalThis like the order: a second evaluated copy of this module that
 * wrote the mark must be read by the store's copy, else the stamp silently
 * falls back to write time.
 */
const responseStarts: WeakMap<Response, number> = ((globalThis as any)[
  Symbol.for("rangojs-router:response-execution-start")
] ??= new WeakMap());

/** Mark the execution start behind a Response handed to putResponse. */
export function markResponseStart(
  response: Response,
  start: ExecutionStart,
): Response {
  responseStarts.set(response, start.at);
  return response;
}

/** The start a writer marked on `response`, if any. */
export function responseStartedAt(response: Response): number | undefined {
  return responseStarts.get(response);
}

/** Record an execution's start, before it reads its data. */
export function executionStart(): ExecutionStart {
  return { seq: order.seq, at: Date.now() };
}

/**
 * Whether this isolate invalidated any of `tags` after `since` (the `seq` of
 * an ExecutionStart), in any request: the execution's value may predate the
 * invalidation, so it is neither joined nor written (#973, #977).
 */
export function invalidatedSince(
  tags: readonly string[] | undefined,
  since: number,
): boolean {
  if (!tags || tags.length === 0) return false;
  if (since < order.forgotten) return true;
  for (const tag of tags) {
    const at = order.tags.get(tag);
    if (at !== undefined && at > since) return true;
  }
  return false;
}

/**
 * Record an invalidation of `tags` in this isolate's order
 * (updateTag()/revalidateTag(), before any store sees it).
 */
export function markInvalidated(tags: readonly string[]): void {
  const at = ++order.seq;
  for (const tag of tags) {
    order.tags.delete(tag);
    order.tags.set(tag, at);
  }
  for (const [tag, seq] of order.tags) {
    if (order.tags.size <= ISOLATE_INVALIDATION_HISTORY) break;
    order.tags.delete(tag);
    order.forgotten = seq;
  }
}
