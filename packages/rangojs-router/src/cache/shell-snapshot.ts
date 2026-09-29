/**
 * Capture data snapshot: recording + seeding stores for PPR shell parity.
 *
 * A PPR HIT serves frozen prelude bytes, then a Flight payload for hydration
 * that must agree with them byte for byte. The handler layer's part of that
 * payload is the capture's own doc segment record: the capture writes it
 * first, renders its prelude from it, and every HIT replays it (no handler
 * runs on a HIT). What still executes on a HIT is the loader layer: live
 * loaders and promise-carrying bake-lane (`ssr: false`) loaders run, and the
 * values the bake-lane ones read must match what the capture baked (a
 * promise-free bake-lane loader is served from its pin and does not run). See docs/design/ppr-shell-resume.md.
 *
 * The mechanism (Next.js resume-data-cache analog, adapted to Rango's cache
 * rings): the CAPTURE render records every cache-store read-hit and write it
 * performed (the {@link RecordingShellStore}); the records ride inside the
 * ShellCacheEntry as its `snapshot`; on a HIT the tail render reads through a
 * {@link SeededShellStore} overlay that serves those recorded values AS FRESH.
 * Everything NOT recorded (the holes — masked loaders were never executed at
 * capture, so their reads were never recorded) stays live.
 *
 * The invariant, verbatim: the snapshot is the doc record plus the cache-store
 * reads the capture's loaders performed; replaying them on a HIT reproduces
 * the shell content byte-identically; everything not recorded stays live.
 * {@link pruneShellSnapshot} drops the rest.
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
  CacheReadError,
} from "./types.js";
import { CACHE_READ_ERROR } from "./types.js";
import { bufferToBase64, base64ToBuffer } from "./cf/cf-base64.js";
import { isPerClientSignalHeader } from "../browser/cookie-name.js";
import { isInsideAnyLoaderScope } from "../server/context.js";

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
 *
 * Loader attribution: every item/response access made inside a loader scope
 * (hit, miss or write) marks its key in {@link loaderKeys}. A loader re-runs
 * on every HIT, so those records stay pinned when the snapshot is pruned. A
 * miss counts too: a loader that joins a handler's in-flight "use cache" call
 * reads the store first (cache-runtime.ts) and finds nothing, and the record
 * then comes from the handler's write.
 */
export class RecordingShellStore<
  TEnv = unknown,
> implements SegmentCacheStore<TEnv> {
  private readonly records = new Map<string, ShellSnapshotRecord>();
  private readonly writes: Promise<unknown>[] = [];
  /** Record keys ({@link recordKey}) a loader read or wrote during the capture. */
  readonly loaderKeys: Set<string> = new Set();

  constructor(private readonly inner: SegmentCacheStore<TEnv>) {}

  get defaults(): SegmentCacheStore<TEnv>["defaults"] {
    return this.inner.defaults;
  }
  get keyGenerator(): SegmentCacheStore<TEnv>["keyGenerator"] {
    return this.inner.keyGenerator;
  }
  get supportsPassiveShellReads(): true | undefined {
    return this.inner.supportsPassiveShellReads;
  }

  private record(
    family: ShellSnapshotRecord["family"],
    key: string,
    value: ShellSnapshotRecord["value"],
  ): void {
    this.records.set(recordKey(family, key), { family, key, value });
  }

  private noteLoaderAccess(
    family: ShellSnapshotRecord["family"],
    key: string,
  ): void {
    if (isInsideAnyLoaderScope()) this.loaderKeys.add(recordKey(family, key));
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
   * must never stall the capture task. Resolves true when every tracked write
   * settled, false at the deadline (settleCaptureRecord then fails the capture
   * when the doc record is among the writes still pending).
   */
  async settleWrites(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.writes.length > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      // Take the current batch; new writes scheduled while awaiting accumulate in
      // this.writes and are drained on the next iteration.
      const batch = this.writes.splice(0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
        (timer as { unref?: () => void }).unref?.();
      });
      const settled = await Promise.race([
        Promise.allSettled(batch).then(() => true as const),
        guard,
      ]);
      if (timer) clearTimeout(timer);
      if (!settled) {
        // Keep tracking the batch: a later settleWrites still waits for it.
        this.writes.unshift(...batch);
        return false;
      }
    }
    return true;
  }

  /** The recorded snapshot (last-write-wins per family+key), or undefined if empty. */
  drainSnapshot(): ShellSnapshotRecord[] | undefined {
    return this.records.size > 0 ? [...this.records.values()] : undefined;
  }

  /** One recorded value, by family and key. */
  getRecord(
    family: ShellSnapshotRecord["family"],
    key: string,
  ): ShellSnapshotRecord["value"] | undefined {
    return this.records.get(recordKey(family, key))?.value;
  }

  async get(key: string): Promise<CacheGetResult | null | CacheReadError> {
    const result = await this.inner.get(key);
    if (result && result !== CACHE_READ_ERROR) {
      this.record("segment", key, result.data);
    }
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
    this.noteLoaderAccess("response", key);
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
    this.noteLoaderAccess("response", key);
    this.record("response", key, await serializeResponse(response));
    return this.inner.putResponse(key, response, ttl, swr, tags);
  }

  async getItem(key: string): Promise<CacheItemResult | null> {
    if (!this.inner.getItem) return null;
    this.noteLoaderAccess("item", key);
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
    this.noteLoaderAccess("item", key);
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
    options?: { claimRevalidation?: boolean },
  ): Promise<{ entry: ShellCacheEntry; shouldRevalidate?: boolean } | null> {
    return this.inner.getShell ? this.inner.getShell(key, options) : null;
  }

  async putShell(
    key: string,
    entry: ShellCacheEntry,
    ttlSeconds?: number,
    swrSeconds?: number,
    tags?: string[],
  ): Promise<"stored" | "invalidated" | "uncacheable" | void> {
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
 * True when `snapshot` carries the canonical doc segment record `docKey`
 * names, with at least one segment: the record partial replay and a
 * fast-path HIT tail consume.
 */
export function hasDocRecord(
  snapshot: readonly ShellSnapshotRecord[] | undefined,
  docKey: string | undefined,
): boolean {
  if (docKey === undefined || !snapshot) return false;
  return snapshot.some((record) => {
    if (
      !record ||
      typeof record !== "object" ||
      record.family !== "segment" ||
      record.key !== docKey ||
      typeof record.value !== "object" ||
      record.value === null
    ) {
      return false;
    }
    const segments = (record.value as { segments?: unknown }).segments;
    return Array.isArray(segments) && segments.length > 0;
  });
}

/**
 * Who reads a stored snapshot besides the doc record
 * (docs/design/shell-entry-layout.md §2):
 * - "segments": nobody. A navigation-only entry is read only by partial
 *   replay, which seeds the doc record alone (SeededShellStore
 *   `segmentsOnly`, implicit doc scope only).
 * - "loaders": the loaders a document HIT re-runs. Every HIT tail replays
 *   the handler layer from the doc record and never runs a handler, so the
 *   records only handler code read are dead weight.
 */
export type ShellSnapshotReaders = "segments" | "loaders";

/**
 * Split a capture's snapshot into what its readers consume and the rest: the
 * doc record (`docKey`) always; with "loaders", the loader-family records and
 * the item/response records a loader touched during the capture
 * (RecordingShellStore.loaderKeys). Every other segment record goes: an
 * explicit cache() tier's reads and writes are keyed where no HIT tail and no
 * partial replay looks (both consult only the doc record). The doc record
 * stays a copy inside the entry: a reference to a separately stored record
 * could be evicted on its own, and the HIT would have nothing to replay.
 */
export function pruneShellSnapshot(
  snapshot: readonly ShellSnapshotRecord[],
  readers: ShellSnapshotReaders,
  loaderKeys: ReadonlySet<string>,
  docKey: string,
): { kept: ShellSnapshotRecord[]; pruned: ShellSnapshotRecord[] } {
  const kept: ShellSnapshotRecord[] = [];
  const pruned: ShellSnapshotRecord[] = [];
  for (const record of snapshot) {
    const keep =
      (record.family === "segment" && record.key === docKey) ||
      (readers === "loaders" &&
        (record.family === "loader" ||
          (record.family !== "segment" &&
            loaderKeys.has(recordKey(record.family, record.key)))));
    (keep ? kept : pruned).push(record);
  }
  return { kept, pruned };
}

/**
 * The shell entry head's fields estimateShellEntryBytes does not measure
 * (versions, timestamps, theme, lengths, flags; about 200 bytes in a
 * CFCacheStore frame) and the frame's 12-byte prefix, with room to spare.
 */
export const SHELL_ENTRY_HEAD_ALLOWANCE_BYTES: number = 512;

const ENTRY_BYTE_ENCODER = new TextEncoder();

/**
 * Bytes (UTF-8) a stored shell entry takes, as the built-in stores write it:
 * the prelude, the snapshot's JSON, and a JSON head that carries the
 * postponed state as an escaped string next to the tags and doc key
 * (CFCacheStore's frame head, VercelCacheStore's envelope), plus
 * SHELL_ENTRY_HEAD_ALLOWANCE_BYTES for the head's fixed fields and the
 * frame prefix. Measuring the raw postponed bytes undercounted: every quote
 * in it is escaped in the head (a /ppr-large/holes entry measured 1,098
 * bytes under its KV value). The capture's whole-entry guard compares this
 * with the store's value limit.
 */
export function estimateShellEntryBytes(parts: {
  preludeBytes: number;
  postponed: string | null | undefined;
  snapshot: readonly ShellSnapshotRecord[] | undefined;
  tags: readonly string[] | undefined;
  docKey: string | undefined;
  prunedRecords: string | undefined;
}): number {
  const head = ENTRY_BYTE_ENCODER.encode(
    JSON.stringify({
      po: parts.postponed,
      t: parts.tags,
      dk: parts.docKey,
      pr: parts.prunedRecords,
    }),
  ).length;
  const snapshot =
    parts.snapshot && parts.snapshot.length > 0
      ? ENTRY_BYTE_ENCODER.encode(JSON.stringify(parts.snapshot)).length
      : 0;
  return (
    parts.preludeBytes + head + snapshot + SHELL_ENTRY_HEAD_ALLOWANCE_BYTES
  );
}

/** Snapshot records by family, e.g. `segment:1/item:5` (no commas: it rides a Server-Timing desc). */
export function countSnapshotFamilies(
  snapshot: readonly ShellSnapshotRecord[],
): string {
  const counts = new Map<string, number>();
  for (const record of snapshot) {
    counts.set(record.family, (counts.get(record.family) ?? 0) + 1);
  }
  return [...counts].map(([family, n]) => `${family}:${n}`).join("/");
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

  async get(key: string): Promise<CacheGetResult | null | CacheReadError> {
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
export interface ShellLoaderSeedEntry {
  /** The Flight-deserialized elided container (recorded paths + markers). */
  container: unknown;
  /**
   * True when the record carries hole markers (or predates the capture-side
   * hole bit, where hole-ness is unknown): the HIT overlay must gate on the
   * fresh run. False = fully pinned; the payload promise resolves immediately
   * from the pin (loader-cache.ts pin-first path).
   */
  holes: boolean;
  /**
   * The record needs its loader body to run on a HIT for pushes the capture
   * could not record (ShellSnapshotLoaderValue.runs). Only read for a
   * hole-free record: a hole-carrying one always runs.
   */
  runs: boolean;
}

export async function buildShellLoaderSeed(
  snapshot: ShellSnapshotRecord[],
): Promise<Map<string, ShellLoaderSeedEntry> | undefined> {
  const loaderRecords: ShellSnapshotRecord[] = [];
  for (const rec of snapshot) {
    if (rec.family === "loader") loaderRecords.push(rec);
  }
  if (loaderRecords.length === 0) return undefined;

  const { deserializeResult } = await import("./segment-codec.js");
  const entries = await Promise.all(
    loaderRecords.map(
      async (rec): Promise<[string, ShellLoaderSeedEntry] | null> => {
        try {
          const stored = rec.value as ShellSnapshotLoaderValue;
          return [
            rec.key,
            {
              container: await deserializeResult(stored.value),
              // A record without a bit predates it: without the hole bit it
              // reads as hole-carrying (unknown hole-ness keeps the gated
              // path), and without the runs bit as runs (its snapshot lacks
              // the loader-owned pushes, so the body supplies them).
              holes: stored.holes !== 0,
              runs: stored.runs !== 0,
            },
          ];
        } catch {
          return null;
        }
      },
    ),
  );
  const seed = new Map<string, ShellLoaderSeedEntry>();
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
 * (the holes — masked loaders were never recorded — stay live). Writes pass
 * through so a live hole may legitimately write, except that `segmentsOnly`
 * fully isolates the segment family: misses do not fall through, and writes or
 * deletes stay local to the navigation overlay. The shell family always passes
 * through. With `segmentsOnly`, item and response reads also pass through so a
 * partial navigation cannot freeze captured data or write a partial result into
 * the canonical document namespace.
 */
export class SeededShellStore<
  TEnv = unknown,
> implements SegmentCacheStore<TEnv> {
  private readonly items: Map<string, ShellSnapshotItemValue> | undefined;
  private readonly segments = new Map<string, CachedEntryData>();
  private readonly responses:
    | Map<string, ShellSnapshotResponseValue>
    | undefined;
  private readonly segmentsOnly: boolean;

  constructor(
    private readonly inner: SegmentCacheStore<TEnv>,
    snapshot: ShellSnapshotRecord[],
    options?: { segmentsOnly?: boolean },
  ) {
    this.segmentsOnly = options?.segmentsOnly === true;
    this.items = this.segmentsOnly ? undefined : new Map();
    this.responses = this.segmentsOnly ? undefined : new Map();
    for (const rec of snapshot) {
      if (!rec || typeof rec !== "object") continue;
      if (rec.family === "segment") {
        this.segments.set(rec.key, rec.value as CachedEntryData);
      } else if (this.segmentsOnly) {
        continue;
      } else if (rec.family === "item") {
        this.items?.set(rec.key, rec.value as ShellSnapshotItemValue);
      } else if (rec.family === "response") {
        this.responses?.set(rec.key, rec.value as ShellSnapshotResponseValue);
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
  get supportsPassiveShellReads(): true | undefined {
    return this.inner.supportsPassiveShellReads;
  }

  async get(key: string): Promise<CacheGetResult | null | CacheReadError> {
    const seeded = this.segments.get(key);
    if (seeded) return { data: seeded, shouldRevalidate: false };
    if (this.segmentsOnly) return null;
    return this.inner.get(key);
  }

  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void> {
    if (this.segmentsOnly) {
      this.segments.set(key, data);
      return;
    }
    return this.inner.set(key, data, ttl, swr);
  }

  async delete(key: string): Promise<boolean> {
    if (this.segmentsOnly) {
      return this.segments.delete(key);
    }
    return this.inner.delete(key);
  }

  async clear(): Promise<void> {
    return this.inner.clear?.();
  }

  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    const seeded = this.responses?.get(key);
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
    const seeded = this.items?.get(key);
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
    options?: { claimRevalidation?: boolean },
  ): Promise<{ entry: ShellCacheEntry; shouldRevalidate?: boolean } | null> {
    return this.inner.getShell ? this.inner.getShell(key, options) : null;
  }

  async putShell(
    key: string,
    entry: ShellCacheEntry,
    ttlSeconds?: number,
    swrSeconds?: number,
    tags?: string[],
  ): Promise<"stored" | "invalidated" | "uncacheable" | void> {
    return this.inner.putShell?.(key, entry, ttlSeconds, swrSeconds, tags);
  }

  async invalidateTags(tags: string[]): Promise<void> {
    return this.inner.invalidateTags?.(tags);
  }
}

/**
 * Thrown by a document HIT tail's match when its doc record cannot supply the
 * handler layer (it failed to decode, or the entry lost it). The tail must not
 * run handlers after the prelude committed, so withCacheLookup throws this
 * instead of resolving segments, and serveShellHit degrades the response:
 * the entry is replaced with a tombstone, the memo is dropped, a recapture is
 * scheduled, and the browser reloads into a MISS.
 */
export class ShellRecordUnavailableError extends Error {
  constructor(docKey: string | undefined) {
    super(
      `PPR shell HIT: the doc record${docKey ? ` "${docKey}"` : ""} could not supply the handler layer`,
    );
    this.name = "ShellRecordUnavailableError";
  }
}
