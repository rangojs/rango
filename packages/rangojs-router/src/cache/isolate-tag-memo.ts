/**
 * Per-isolate tag-marker memos shared by the built-in stores (issue #941;
 * docs/design/shell-entry-layout.md "The tag-marker memo").
 *
 * A tagged shell HIT waits for its tag-invalidation markers before the first
 * byte. Two things here shorten that wait:
 *
 * - {@link TagNameHints}: which tag NAMES a shell key carried last time, so a
 *   HIT can start the marker reads alongside the entry read instead of after
 *   the entry's head names its tags. Never marker values.
 * - {@link TagMarkerMemo}: the marker VALUES (a tag's latest invalidatedAt,
 *   or null), served stale-while-revalidate. A value younger than
 *   `markerFreshMs` is used as is; one younger than `markerMaxStaleMs` is used
 *   and refreshed from the store in the background; an older one blocks on
 *   the store read as before.
 *
 * Simple reads get SWR; a mutation gets correct reads. The request that runs
 * updateTag()/revalidateTag() reads its own writes through the per-request
 * memo; the isolate that runs it writes the new value through into this memo;
 * and its response sets the fresh-reads cookie (request-context.ts), so the
 * same user's next requests on OTHER isolates skip this memo and the shell
 * memo for as long as either can be stale. Other users can see a marker up to
 * `markerMaxStaleMs` old, on top of the platform's own consistency
 * (Cloudflare KV is eventually consistent across locations, up to about 60 s;
 * Vercel's `tm` markers are regional).
 *
 * Only PPR shell reads use the value memo. Cached data families (`cache()`,
 * `"use cache"`, responses) and the shell write gate
 * (`isTagsInvalidatedSince`) keep reading their markers, in every request,
 * whatever its shell read found: a shell read's memoized values never reach
 * the data families' per-request memo (cf-tag-marker-memo.ts
 * ShellMarkerReads).
 */

import type { RequestContext } from "../server/request-context.js";
import type { ShellReadStats } from "./types.js";

/** Default freshness of a memoized marker on CFCacheStore (ms). */
export const DEFAULT_CF_MARKER_FRESH_MS = 1000;
/** Default freshness of a memoized marker on VercelCacheStore (ms). */
export const DEFAULT_VERCEL_MARKER_FRESH_MS = 300;
/** Default oldest memoized marker served while it refreshes (ms), CF. */
export const DEFAULT_CF_MARKER_MAX_STALE_MS = 10_000;
/**
 * The same cap on VercelCacheStore: the runtime cache expires tags globally
 * within about 300 ms, so a much longer stale window would widen that for
 * other users more than KV's own up-to-60 s cross-location lag does on CF.
 */
export const DEFAULT_VERCEL_MARKER_MAX_STALE_MS = 2000;
/** Most tags a marker memo holds (least recently used evicted). */
const MARKER_MEMO_MAX_ENTRIES = 4096;
/** Most shell keys a hint map holds (least recently used evicted). */
const TAG_HINTS_MAX_ENTRIES = 2048;

/** How a marker read was answered, for the debugPerformance marker row. */
export type MarkerMemoOutcome = "fresh" | "stale" | "read" | "bypass";

interface MarkerSlot {
  value: number | null;
  readAt: number;
}

/** A memoized marker a read may use: its value, and whether it is stale. */
export interface MarkerMemoHit {
  value: number | null;
  stale: boolean;
}

/**
 * A store read of a marker for {@link TagMarkerMemo.readThrough}: the value,
 * and whether it may be memoized (a timed-out read that failed open may not).
 */
export interface MarkerFetch {
  value: number | null;
  memoize: boolean;
}

/** Options of {@link TagMarkerMemo.readThrough}. */
export interface MarkerReadThroughOptions {
  /** Fresh window (ms); 0 or less reads the store and memoizes nothing. */
  freshMs: number;
  /** The oldest value served while it refreshes (ms). */
  maxStaleMs: number;
  /** The request carries the fresh-reads cookie: read the store. */
  bypass: boolean;
  /** Keeps a background refresh alive after the response (waitUntil). */
  keepAlive?: (pending: Promise<void>) => void;
  /** How the read was answered, for the debugPerformance marker row. */
  onOutcome?: (outcome: MarkerMemoOutcome) => void;
}

export class TagMarkerMemo {
  private readonly slots = new Map<string, MarkerSlot>();
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(private readonly maxEntries: number = MARKER_MEMO_MAX_ENTRIES) {}

  /**
   * The memoized marker for `key` if it is younger than `maxStaleMs` (stale
   * when older than `freshMs`), or undefined when the caller must read the
   * store. `freshMs <= 0` disables the memo.
   */
  lookup(
    key: string,
    freshMs: number,
    maxStaleMs: number,
    now: number = Date.now(),
  ): MarkerMemoHit | undefined {
    if (freshMs <= 0) return undefined;
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    const age = now - slot.readAt;
    if (age >= Math.max(freshMs, maxStaleMs)) return undefined;
    this.slots.delete(key);
    this.slots.set(key, slot);
    return { value: slot.value, stale: age >= freshMs };
  }

  /**
   * Record a marker the store returned to a read that started at
   * `readStartedAt`. The age counts from the read's start, not its end: a
   * marker written while the read was in flight may be missing from it, so
   * the value is only known to be current as of the start. Markers only move
   * forward, so a value older than one already held (a write-through that
   * landed during the read) is kept at the newer value, with the later stamp.
   */
  store(
    key: string,
    value: number | null,
    readStartedAt: number = Date.now(),
  ): void {
    const held = this.slots.get(key);
    const heldValue = held?.value ?? null;
    const next =
      heldValue !== null && (value === null || heldValue > value)
        ? heldValue
        : value;
    this.slots.delete(key);
    this.slots.set(key, {
      value: next,
      readAt: Math.max(held?.readAt ?? readStartedAt, readStartedAt),
    });
    if (this.slots.size > this.maxEntries) {
      const oldest = this.slots.keys().next().value as string;
      this.slots.delete(oldest);
    }
  }

  /**
   * Refresh a stale marker in the background: one read per key at a time,
   * handed to `keepAlive` (the store's waitUntil) so the runtime lets it
   * finish after the response; without it the read runs detached. A read
   * that fails, or may not be memoized, stores nothing.
   */
  refresh(
    key: string,
    read: () => Promise<MarkerFetch>,
    keepAlive?: (pending: Promise<void>) => void,
  ): void {
    if (this.refreshing.has(key)) return;
    const pending = (async (): Promise<void> => {
      const startedAt = Date.now();
      try {
        const { value, memoize } = await read();
        if (memoize) this.store(key, value, startedAt);
      } catch {
        // The next read past the stale window blocks on the store anyway.
      } finally {
        this.refreshing.delete(key);
      }
    })();
    this.refreshing.set(key, pending);
    keepAlive?.(pending);
  }

  /**
   * A marker through the memo, stale-while-revalidate: a value within
   * `freshMs` is used as is; one within `maxStaleMs` is used while one
   * background read refreshes it; otherwise, and for a request carrying the
   * fresh-reads cookie, the store is read (`fetch(false)`) and the result
   * memoized. `fetch(true)` is the background refresh, outside any request.
   */
  async readThrough(
    key: string,
    fetch: (background: boolean) => Promise<MarkerFetch>,
    options: MarkerReadThroughOptions,
  ): Promise<number | null> {
    if (options.freshMs <= 0) return (await fetch(false)).value;
    if (!options.bypass) {
      const hit = this.lookup(key, options.freshMs, options.maxStaleMs);
      if (hit) {
        options.onOutcome?.(hit.stale ? "stale" : "fresh");
        if (hit.stale) this.refresh(key, () => fetch(true), options.keepAlive);
        return hit.value;
      }
    }
    const startedAt = Date.now();
    const { value, memoize } = await fetch(false);
    if (memoize) this.store(key, value, startedAt);
    options.onOutcome?.(options.bypass ? "bypass" : "read");
    return value;
  }

  clear(): void {
    this.slots.clear();
    this.refreshing.clear();
  }
}

/**
 * The tag names a shell key's entry carried when it was last read or written
 * in this isolate, so the next HIT can start their marker reads before the
 * entry names them. A wrong or missing hint costs a wasted read or nothing;
 * the freshness check always uses the entry's own tags.
 */
export class TagNameHints {
  private readonly keys = new Map<string, readonly string[]>();

  constructor(private readonly maxEntries: number = TAG_HINTS_MAX_ENTRIES) {}

  get(key: string): readonly string[] | undefined {
    return this.keys.get(key);
  }

  remember(key: string, tags: readonly string[] | undefined): void {
    this.keys.delete(key);
    if (!tags || tags.length === 0) return;
    this.keys.set(key, tags);
    if (this.keys.size > this.maxEntries) {
      const oldest = this.keys.keys().next().value as string;
      this.keys.delete(oldest);
    }
  }

  clear(): void {
    this.keys.clear();
  }
}

/** The union of a key's remembered tag names and the route's static tags. */
export function hintedTags(
  remembered: readonly string[] | undefined,
  routeTags: readonly string[] | undefined,
): string[] {
  if (!routeTags || routeTags.length === 0)
    return remembered ? [...remembered] : [];
  if (!remembered || remembered.length === 0) return [...routeTags];
  return [...new Set([...remembered, ...routeTags])];
}

/**
 * The marker row's memo outcome for a read's tags: the most store-bound one
 * (a bypass or store read outranks a stale value, which outranks a fresh one).
 */
export function summarizeMarkerOutcomes(
  tags: readonly string[] | undefined,
  outcomes: ReadonlyMap<string, MarkerMemoOutcome>,
): MarkerMemoOutcome | undefined {
  let summary: MarkerMemoOutcome | undefined;
  for (const tag of tags ?? []) {
    const outcome = outcomes.get(tag);
    if (
      outcome &&
      (!summary || OUTCOME_RANK[outcome] > OUTCOME_RANK[summary])
    ) {
      summary = outcome;
    }
  }
  return summary;
}

const OUTCOME_RANK: Record<MarkerMemoOutcome, number> = {
  fresh: 0,
  stale: 1,
  read: 2,
  bypass: 3,
};

/**
 * Fill a shell read's marker-row stats (debugPerformance) for the entry's
 * own tags: the memo outcome, and how many of them the read had hinted.
 */
export function recordMarkerRow(
  stats: ShellReadStats,
  tags: readonly string[] | undefined,
  outcomes: ReadonlyMap<string, MarkerMemoOutcome> | undefined,
): void {
  if (!tags || tags.length === 0) return;
  if (outcomes) stats.markerMemo = summarizeMarkerOutcomes(tags, outcomes);
  if (stats.markerHinted) {
    const hinted = stats.markerHinted;
    stats.markerHintHits = tags.filter((tag) => hinted.includes(tag)).length;
  }
}

/**
 * True when this request carries the fresh-reads cookie: a request of the same
 * user after an updateTag()/revalidateTag(), which must not be served from an
 * isolate memo (shell or marker) that could predate the mutation.
 */
export function freshReadsRequired(
  ctx: Pick<RequestContext, "_freshReads"> | undefined,
): boolean {
  return ctx?._freshReads === true;
}
