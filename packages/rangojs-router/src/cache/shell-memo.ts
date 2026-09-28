/**
 * Per-isolate memo of fresh PPR shell reads (issue #941, decision 1;
 * docs/design/shell-entry-layout.md).
 *
 * A warm isolate serving the same shell many times a second re-reads, and
 * re-parses, the same stored entry on every HIT. The store keeps the last
 * fresh read per key for a short window (`memo.shellMs`) and serves the next
 * HIT from memory. What the memo does NOT skip is the part that decides
 * whether the entry may be served: the store still runs its tag-marker check
 * on every read, so with KV bound `updateTag()` / `revalidateTag()` stay
 * immediate across isolates. The isolate that runs the invalidation drops its
 * own copies and keeps reads that were in flight from memoizing them again
 * (RecentTagInvalidations). What another isolate can serve for up to one
 * window: a newer capture of the same key; a KV-less purge-mode purge; on
 * Vercel, an invalidation from another region (tag markers are regional) and
 * a platform `expireTag` issued outside rango (it writes no tag marker).
 *
 * Store instances are usually created per request, so the memo must outlive
 * them: CFCacheStore keeps one module-level memo per isolate, VercelCacheStore
 * one per runtime-cache handle (the handle carries the namespace). One byte
 * budget (`memo.shellMaxBytes`) caps a memo; storing sweeps entries past their
 * window, then evicts the least recently used. Measured on a 3.2 MB shell
 * (Node 22 heap): CFCacheStore holds 1.08x what it counts (prelude plus
 * snapshot JSON); VercelCacheStore holds 0.93x (envelope JSON plus the
 * decoded prelude).
 */

/**
 * Per-isolate memos a built-in store keeps (`CFCacheStore`: one per isolate;
 * `VercelCacheStore`: one per `cache` handle). A window of 0 turns that memo
 * off.
 */
export interface StoreMemoOptions {
  /**
   * PPR shell memo window (ms): after a shell read, the next HITs of that key
   * within the window are served from memory, with no store read and no
   * parse. Only a fresh shell whose snapshot read completed is kept. The
   * tag-marker check still runs on every HIT, and the isolate that runs
   * `updateTag()` / `revalidateTag()` drops its own copies, so neither that
   * request nor a later one on the same isolate gets the invalidated shell.
   * What ANOTHER isolate can serve for up to one window:
   * - a newer capture of the same key;
   * - `CFCacheStore` without KV, in purge mode: a purged shell. The purge
   *   removes the stored entry, not other isolates' memos, and this includes
   *   the mutating user's next request when it lands on another isolate; set
   *   `{ shellMs: 0 }` where that request must read its own write;
   * - `VercelCacheStore`: an invalidation from another region (the tag
   *   markers are a regional `cache.set`; only `expireTag` is global), and a
   *   platform `expireTag` issued outside rango.
   *
   * Default 2000.
   */
  shellMs?: number;
  /**
   * Total bytes (prelude plus snapshot) the shell memo may hold; the least
   * recently used shells are evicted first, and a shell larger than the whole
   * budget is not kept. Default 16 MiB. 0 turns the memo off.
   */
  shellMaxBytes?: number;
}

/** Default memo window (ms). */
export const DEFAULT_SHELL_MEMO_MS = 2000;

/** Default total memo size per isolate (bytes). */
export const DEFAULT_SHELL_MEMO_MAX_BYTES: number = 16 * 1024 * 1024;

/** A store's memo options, validated. */
export interface ResolvedShellMemoOptions {
  shellMs: number;
  shellMaxBytes: number;
}

/**
 * Validate a store's `memo` option. A non-finite value (`NaN` from
 * `Number(env.UNSET)`, `Infinity`, null) falls back to the default, like the
 * CFCacheStore read budgets; a finite 0 or negative passes through and turns
 * the memo off.
 */
export function resolveShellMemoOptions(
  memo: StoreMemoOptions | undefined,
): ResolvedShellMemoOptions {
  const finite = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    shellMs: finite(memo?.shellMs, DEFAULT_SHELL_MEMO_MS),
    shellMaxBytes: finite(memo?.shellMaxBytes, DEFAULT_SHELL_MEMO_MAX_BYTES),
  };
}

/**
 * Whether a shell is neither stale nor expired: the only kind a memo keeps or
 * serves (a stale read stays with the store, which schedules the recapture).
 */
export function isShellFresh(
  staleAt: number,
  expiresAt: number,
  now: number = Date.now(),
): boolean {
  return !(staleAt > 0 && now > staleAt) && now <= expiresAt;
}

/** Whether a shell's tags include any of `tags`. */
export function shellHasAnyTag(
  shellTags: readonly string[] | undefined,
  tags: readonly string[],
): boolean {
  return shellTags?.some((tag) => tags.includes(tag)) === true;
}

interface ShellMemoSlot<T> {
  value: T;
  bytes: number;
  storedAt: number;
  /** storedAt + the storing store's window: past it, set() sweeps the slot. */
  expiresAt: number;
}

export class ShellMemo<T> {
  private readonly slots = new Map<string, ShellMemoSlot<T>>();
  private totalBytes = 0;

  /**
   * The value stored under `key` less than `windowMs` ago, or undefined.
   * A hit becomes the most recently used entry.
   */
  get(key: string, windowMs: number, now: number = Date.now()): T | undefined {
    if (windowMs <= 0) return undefined;
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    this.slots.delete(key);
    if (now - slot.storedAt >= windowMs) {
      this.totalBytes -= slot.bytes;
      return undefined;
    }
    this.slots.set(key, slot);
    return slot.value;
  }

  /**
   * Store `value` (`bytes` counted against `maxBytes`). Entries past their own
   * window are dropped first, so a key that is never read again does not hold
   * memory until the cap pushes it out; then the least recently used entries
   * are evicted until the value fits. A value larger than the whole budget, or
   * a window of 0, is not stored.
   */
  set(
    key: string,
    value: T,
    bytes: number,
    windowMs: number,
    maxBytes: number,
    now: number = Date.now(),
  ): void {
    this.delete(key);
    if (windowMs <= 0 || bytes > maxBytes) return;
    for (const [other, slot] of this.slots) {
      if (now >= slot.expiresAt) this.delete(other);
    }
    for (const [oldest, slot] of this.slots) {
      if (this.totalBytes + bytes <= maxBytes) break;
      this.slots.delete(oldest);
      this.totalBytes -= slot.bytes;
    }
    this.slots.set(key, {
      value,
      bytes,
      storedAt: now,
      expiresAt: now + windowMs,
    });
    this.totalBytes += bytes;
  }

  delete(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    this.totalBytes -= slot.bytes;
  }

  /** Drop every entry `predicate` selects. */
  deleteWhere(predicate: (value: T) => boolean): void {
    for (const [key, slot] of this.slots) {
      if (predicate(slot.value)) this.delete(key);
    }
  }

  /** Bytes currently held. */
  get size(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.slots.clear();
    this.totalBytes = 0;
  }
}

interface TagInvalidationRecord {
  /** The latest invalidation's timestamp. */
  at: number;
  /** Invalidations of the tag still writing their markers or purge. */
  pending: number;
  /** When the record may be dropped once nothing is pending. */
  heldUntil: number;
}

/**
 * Tags this isolate invalidated recently, and when. `invalidateTags()` drops
 * the isolate's memoized shells for its tags at once, but a read that was in
 * flight (its store read done, its snapshot still arriving) can memoize one
 * of them again while the markers or the purge are still being written. With
 * KV that copy is harmless (every memo hit reads the markers); in KV-less
 * purge mode the memo-hit check sees only the request's own marker memo, so
 * nothing would reject it for a whole window, and the mutating user's next
 * request on this isolate got the invalidated shell.
 *
 * A record lives from the invalidation's start until `holdMs` after it
 * settles, which covers a read in flight when it settled (its snapshot read
 * is bounded by the store's read budget, 170 ms by default on CFCacheStore).
 * While it lives, a shell carrying the tag and tagged at or before the
 * invalidation is neither memoized nor served from the memo. It only adds
 * rejections: a shell tagged after the invalidation is not affected, and no
 * marker read is skipped. Records are per tag across namespaces, like the
 * memo drop in `invalidateTags()`: another namespace's shell with the same
 * tag skips the memo for the record's life.
 */
export class RecentTagInvalidations {
  private readonly records = new Map<string, TagInvalidationRecord>();

  /** An invalidation of `tags` at `at` started. */
  begin(tags: readonly string[], at: number, now: number = Date.now()): void {
    for (const [tag, record] of this.records) {
      if (record.pending === 0 && now >= record.heldUntil) {
        this.records.delete(tag);
      }
    }
    for (const tag of tags) {
      const record = this.records.get(tag);
      if (record) {
        record.at = Math.max(record.at, at);
        record.pending++;
      } else {
        this.records.set(tag, { at, pending: 1, heldUntil: 0 });
      }
    }
  }

  /** The invalidation begun for `tags` settled: hold its records `holdMs`. */
  settle(
    tags: readonly string[],
    holdMs: number,
    now: number = Date.now(),
  ): void {
    for (const tag of tags) {
      const record = this.records.get(tag);
      if (!record) continue;
      record.pending = Math.max(0, record.pending - 1);
      record.heldUntil = Math.max(record.heldUntil, now + holdMs);
    }
  }

  /**
   * Whether a shell carrying `tags`, tagged at `taggedAt`, predates a live
   * record of one of them (a tagged shell with no tag time is treated as
   * predating it).
   */
  covers(
    tags: readonly string[] | undefined,
    taggedAt: number | undefined,
    now: number = Date.now(),
  ): boolean {
    if (!tags || this.records.size === 0) return false;
    for (const tag of tags) {
      const record = this.records.get(tag);
      if (!record) continue;
      if (record.pending === 0 && now >= record.heldUntil) continue;
      if (taggedAt === undefined || taggedAt <= record.at) return true;
    }
    return false;
  }

  clear(): void {
    this.records.clear();
  }
}
