/**
 * Capture data snapshot: recording + seeding stores for PPR shell parity.
 *
 * The scar tissue this fixes: a PPR HIT serves frozen prelude bytes, then a
 * FULL FRESH Flight render for hydration. Any shell-baked (non-hole) content
 * that drifts between capture time and hit time — a cache() segment with a
 * shorter ttl than the shell, a tag-invalidated item — makes the fresh payload
 * disagree with the prelude, so React throws a hydration text mismatch and
 * regenerates the tree client-side (wiping the FOUC theme class, flashing
 * content). See docs/design/ppr-shell-resume.md.
 *
 * The fix (Next.js resume-data-cache analog, adapted to Rango's cache rings):
 * the CAPTURE render records every cache-store read-hit and write it performed
 * (the {@link RecordingShellStore}); the record rides inside the ShellCacheEntry
 * as its `snapshot`; on a HIT the tail render reads through a
 * {@link SeededShellStore} overlay that serves those recorded values AS FRESH,
 * so the shell region reproduces byte-identically while everything NOT recorded
 * (the holes — masked loaders were never executed at capture, so their reads
 * were never recorded) stays live.
 *
 * The invariant, verbatim: the snapshot is exactly the set of cache-store reads
 * the capture render performed; replaying them on a HIT reproduces the shell
 * content byte-identically; everything not recorded stays live.
 */

import type {
  SegmentCacheStore,
  CacheGetResult,
  CacheItemResult,
  CacheItemOptions,
  CachedEntryData,
  ShellCacheEntry,
  ShellSnapshotRecord,
  ShellSnapshotItemValue,
  ShellSnapshotResponseValue,
  ShellSnapshotLoaderValue,
} from "./types.js";
import { bufferToBase64, base64ToBuffer } from "./cf/cf-base64.js";
import { isPerClientSignalHeader } from "../browser/cookie-name.js";

/** Compose the last-write-wins map key. NUL (`\u0000`) cannot appear in a cache key. */
function recordKey(family: ShellSnapshotRecord["family"], key: string): string {
  return `${family}\u0000${key}`;
}

/** Serialize a Response to the snapshot's stored shape (base64 body). */
async function serializeResponse(
  response: Response,
): Promise<ShellSnapshotResponseValue> {
  const body = await response.clone().arrayBuffer();
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    // Mirror putResponse: per-client signal headers never enter a shared entry.
    if (isPerClientSignalHeader(name)) return;
    headers.push([name, value]);
  });
  return { status: response.status, headers, body: bufferToBase64(body) };
}

/** Rebuild a live Response from a snapshot's stored response shape. */
function deserializeResponse(value: ShellSnapshotResponseValue): Response {
  return new Response(base64ToBuffer(value.body), {
    status: value.status,
    headers: new Headers(value.headers),
  });
}

/**
 * A store wrapper the CAPTURE render reads through. Every call passes through to
 * the underlying store unchanged; for the item/segment/response families it also
 * RECORDS, last-write-wins per (family, key):
 *   - read-hits (get/getItem/getResponse returning non-null) — the value that
 *     fed the shell,
 *   - writes (set/setItem/putResponse) — the value a MISS computed and baked.
 * The shell family (getShell/putShell) is never recorded (the snapshot rides
 * inside a shell entry). Reads that MISS are not recorded (a miss produced no
 * shell content; if the render then computed and wrote, that write is recorded).
 *
 * Deferred writes: cache writes run under waitUntil (fire-and-forget on Node,
 * executionContext on workerd), so their setItem/set calls — hence their records
 * — may land after the shell has quiesced. The capture collects those write
 * promises via {@link trackWrite} and awaits them ({@link settleWrites}) before
 * draining, so a MISS-at-capture value is still pinned.
 */
export class RecordingShellStore<
  TEnv = unknown,
> implements SegmentCacheStore<TEnv> {
  private readonly records = new Map<string, ShellSnapshotRecord>();
  private readonly writes: Promise<unknown>[] = [];

  constructor(private readonly inner: SegmentCacheStore<TEnv>) {}

  get defaults(): SegmentCacheStore<TEnv>["defaults"] {
    return this.inner.defaults;
  }
  get keyGenerator(): SegmentCacheStore<TEnv>["keyGenerator"] {
    return this.inner.keyGenerator;
  }

  private record(
    family: ShellSnapshotRecord["family"],
    key: string,
    value: ShellSnapshotRecord["value"],
  ): void {
    this.records.set(recordKey(family, key), { family, key, value });
  }

  /** Track a deferred cache-write promise so the capture can await it pre-drain. */
  trackWrite(p: Promise<unknown>): void {
    this.writes.push(p);
  }

  /**
   * Record a segment-family write into the snapshot WITHOUT touching the inner
   * store. The shell fast path's implicit doc-cache scope writes through this
   * (via {@link SnapshotOnlySegmentStore}): the recorded doc entry must ride
   * ONLY inside the shell entry — a passthrough write would leave a doc-keyed
   * entry in the real store that the NEXT capture's lookup would hit, replaying
   * the previous generation's segments instead of re-running handlers (breaking
   * SWR recapture freshness).
   */
  recordSegmentWrite(key: string, data: CachedEntryData): void {
    this.record("segment", key, data);
  }

  /**
   * Await the tracked deferred writes so their records are present before drain.
   * Drains ITERATIVELY: a write task can schedule a NESTED write (the ring-3
   * cacheRoute path schedules its actual store.set in a second waitUntil while the
   * first is running), so each awaited batch may enqueue more. Loop until the
   * queue empties or the deadline passes. Bounded: a pathologically slow write
   * must never stall the capture task, so a key that does not settle in time is
   * left unpinned (it drifts, the pre-snapshot behavior) rather than hanging.
   */
  async settleWrites(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.writes.length > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      // Take the current batch; new writes scheduled while awaiting accumulate in
      // this.writes and are drained on the next iteration.
      const batch = this.writes.splice(0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
        (timer as { unref?: () => void }).unref?.();
      });
      await Promise.race([Promise.allSettled(batch).then(() => {}), guard]);
      if (timer) clearTimeout(timer);
    }
  }

  /** The recorded snapshot (last-write-wins per family+key), or undefined if empty. */
  drainSnapshot(): ShellSnapshotRecord[] | undefined {
    return this.records.size > 0 ? [...this.records.values()] : undefined;
  }

  async get(key: string): Promise<CacheGetResult | null> {
    const result = await this.inner.get(key);
    if (result) this.record("segment", key, result.data);
    return result;
  }

  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void> {
    this.record("segment", key, data);
    return this.inner.set(key, data, ttl, swr);
  }

  async delete(key: string): Promise<boolean> {
    return this.inner.delete(key);
  }

  async clear(): Promise<void> {
    return this.inner.clear?.();
  }

  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    if (!this.inner.getResponse) return null;
    const result = await this.inner.getResponse(key);
    if (result)
      this.record("response", key, await serializeResponse(result.response));
    return result;
  }

  async putResponse(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void> {
    if (!this.inner.putResponse) return;
    this.record("response", key, await serializeResponse(response));
    return this.inner.putResponse(key, response, ttl, swr, tags);
  }

  async getItem(key: string): Promise<CacheItemResult | null> {
    if (!this.inner.getItem) return null;
    const result = await this.inner.getItem(key);
    if (result) {
      const value: ShellSnapshotItemValue = {
        value: result.value,
        handles: result.handles,
        tags: result.tags,
      };
      this.record("item", key, value);
    }
    return result;
  }

  async setItem(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void> {
    if (!this.inner.setItem) return;
    const stored: ShellSnapshotItemValue = {
      value,
      handles: options?.handles,
      tags: options?.tags,
    };
    this.record("item", key, stored);
    return this.inner.setItem(key, value, options);
  }

  async getShell(
    key: string,
  ): Promise<{ entry: ShellCacheEntry; shouldRevalidate?: boolean } | null> {
    return this.inner.getShell ? this.inner.getShell(key) : null;
  }

  async putShell(
    key: string,
    entry: ShellCacheEntry,
    ttlSeconds?: number,
    swrSeconds?: number,
    tags?: string[],
  ): Promise<void> {
    return this.inner.putShell?.(key, entry, ttlSeconds, swrSeconds, tags);
  }

  async invalidateTags(tags: string[]): Promise<void> {
    return this.inner.invalidateTags?.(tags);
  }
}

/** True iff `store` is a RecordingShellStore (duck-typed across module copies). */
export function getRecordingStore<TEnv>(
  store: SegmentCacheStore<TEnv> | undefined,
): RecordingShellStore<TEnv> | undefined {
  return store instanceof RecordingShellStore ? store : undefined;
}

/**
 * The store the shell fast path's IMPLICIT doc-cache scope resolves during a
 * capture: reads pass through the recording store (a real-store hit is
 * recorded, exactly like any capture read), but segment WRITES are recorded
 * into the snapshot only — see {@link RecordingShellStore.recordSegmentWrite}
 * for why passthrough would break SWR recapture. Routes with their OWN
 * cache() config never see this store (their scope resolves the app-level
 * recording store and keeps today's record-and-write behavior).
 */
export class SnapshotOnlySegmentStore<
  TEnv = unknown,
> implements SegmentCacheStore<TEnv> {
  constructor(private readonly recording: RecordingShellStore<TEnv>) {}

  get defaults(): SegmentCacheStore<TEnv>["defaults"] {
    return this.recording.defaults;
  }
  get keyGenerator(): SegmentCacheStore<TEnv>["keyGenerator"] {
    return this.recording.keyGenerator;
  }

  async get(key: string): Promise<CacheGetResult | null> {
    return this.recording.get(key);
  }

  async set(key: string, data: CachedEntryData): Promise<void> {
    this.recording.recordSegmentWrite(key, data);
  }

  async delete(key: string): Promise<boolean> {
    return this.recording.delete(key);
  }
}

/**
 * Materialize the loader-family seed from a shell snapshot for a HIT's tail
 * render: Flight-deserialize each recorded (promise-elided) bake-lane
 * container into a segment-key -> container Map, which serveShellHit assigns
 * to the tail context's `_shellLoaderSeed` for the resolveLoaderData overlay.
 * Lives here so every snapshot family is decoded in this module (the
 * item/segment/response families via {@link SeededShellStore}); the loader
 * family is not a store read, so it seeds the context instead of a store.
 *
 * Deserializations run in parallel; a record that fails to decode is skipped
 * (that loader drifts — the pre-snapshot behavior — instead of failing the
 * HIT). Returns undefined when the snapshot carries no loader records, without
 * touching the Flight codec (kept lazy for cold paths and non-RSC configs).
 */
export async function buildShellLoaderSeed(
  snapshot: ShellSnapshotRecord[],
): Promise<Map<string, unknown> | undefined> {
  const loaderRecords: ShellSnapshotRecord[] = [];
  for (const rec of snapshot) {
    if (rec.family === "loader") loaderRecords.push(rec);
  }
  if (loaderRecords.length === 0) return undefined;

  const { deserializeResult } = await import("./segment-codec.js");
  const entries = await Promise.all(
    loaderRecords.map(async (rec): Promise<[string, unknown] | null> => {
      try {
        return [
          rec.key,
          await deserializeResult(
            (rec.value as ShellSnapshotLoaderValue).value,
          ),
        ];
      } catch {
        return null;
      }
    }),
  );
  const seed = new Map<string, unknown>();
  for (const entry of entries) {
    if (entry) seed.set(entry[0], entry[1]);
  }
  return seed.size > 0 ? seed : undefined;
}

/**
 * A read-through overlay the HIT tail render reads through. For a key present in
 * the snapshot it serves the recorded value AS FRESH (shouldRevalidate: false —
 * a pinned key must NOT kick SWR background revalidation) so the tail's payload
 * matches the frozen prelude. Every other read falls through to the real store
 * (the holes — masked loaders were never recorded — stay live). ALL writes pass
 * through unchanged: a live hole's loader may legitimately write. The shell
 * family always passes through.
 */
export class SeededShellStore<
  TEnv = unknown,
> implements SegmentCacheStore<TEnv> {
  private readonly items = new Map<string, ShellSnapshotItemValue>();
  private readonly segments = new Map<string, CachedEntryData>();
  private readonly responses = new Map<string, ShellSnapshotResponseValue>();

  constructor(
    private readonly inner: SegmentCacheStore<TEnv>,
    snapshot: ShellSnapshotRecord[],
  ) {
    for (const rec of snapshot) {
      if (rec.family === "item") {
        this.items.set(rec.key, rec.value as ShellSnapshotItemValue);
      } else if (rec.family === "segment") {
        this.segments.set(rec.key, rec.value as CachedEntryData);
      } else if (rec.family === "response") {
        this.responses.set(rec.key, rec.value as ShellSnapshotResponseValue);
      }
      // "loader" family records are not store reads — serveShellHit seeds them
      // onto the tail context (_shellLoaderSeed) for the resolveLoaderData
      // overlay instead.
    }
  }

  get defaults(): SegmentCacheStore<TEnv>["defaults"] {
    return this.inner.defaults;
  }
  get keyGenerator(): SegmentCacheStore<TEnv>["keyGenerator"] {
    return this.inner.keyGenerator;
  }

  async get(key: string): Promise<CacheGetResult | null> {
    const seeded = this.segments.get(key);
    if (seeded) return { data: seeded, shouldRevalidate: false };
    return this.inner.get(key);
  }

  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void> {
    return this.inner.set(key, data, ttl, swr);
  }

  async delete(key: string): Promise<boolean> {
    return this.inner.delete(key);
  }

  async clear(): Promise<void> {
    return this.inner.clear?.();
  }

  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    const seeded = this.responses.get(key);
    if (seeded) {
      return { response: deserializeResponse(seeded), shouldRevalidate: false };
    }
    return this.inner.getResponse ? this.inner.getResponse(key) : null;
  }

  async putResponse(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void> {
    return this.inner.putResponse?.(key, response, ttl, swr, tags);
  }

  async getItem(key: string): Promise<CacheItemResult | null> {
    const seeded = this.items.get(key);
    if (seeded) {
      return {
        value: seeded.value,
        handles: seeded.handles,
        tags: seeded.tags,
        shouldRevalidate: false,
      };
    }
    return this.inner.getItem ? this.inner.getItem(key) : null;
  }

  async setItem(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void> {
    return this.inner.setItem?.(key, value, options);
  }

  async getShell(
    key: string,
  ): Promise<{ entry: ShellCacheEntry; shouldRevalidate?: boolean } | null> {
    return this.inner.getShell ? this.inner.getShell(key) : null;
  }

  async putShell(
    key: string,
    entry: ShellCacheEntry,
    ttlSeconds?: number,
    swrSeconds?: number,
    tags?: string[],
  ): Promise<void> {
    return this.inner.putShell?.(key, entry, ttlSeconds, swrSeconds, tags);
  }

  async invalidateTags(tags: string[]): Promise<void> {
    return this.inner.invalidateTags?.(tags);
  }
}
