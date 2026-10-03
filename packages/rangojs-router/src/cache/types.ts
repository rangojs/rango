/**
 * Cache Store Types
 *
 * Generic caching interface supporting multiple value types.
 * Designed to be implemented by different backends:
 * - MemoryCacheStore (dev/testing)
 * - Cloudflare Cache API adapter
 * - Cloudflare KV adapter
 * - Redis adapter
 */

import type { ResolvedSegment } from "../types.js";
import type { RequestContext } from "../server/request-context.js";

/**
 * Sentinel a `SegmentCacheStore.get` MAY return instead of `null` when the
 * read FAILED (backend error) rather than genuinely missing. For the render
 * outcome the two are identical — render fresh, re-cache — so hit/miss-only
 * consumers can treat it as a miss. The PPR replay composition needs the
 * distinction: an errored explicit-tier read must render uncached
 * (`lookupRouteDetailed` classifies it `error`), never be substituted by the
 * seeded doc record — the built-in stores swallow backend errors internally,
 * so without this signal their failures read as replayable misses. Third-party
 * stores returning plain `null` on error keep the miss classification.
 */
export const CACHE_READ_ERROR: unique symbol = Symbol.for(
  "rango.cache.readError",
);
export type CacheReadError = typeof CACHE_READ_ERROR;

/**
 * Result from cache get() including data and revalidation status
 */
export interface CacheGetResult {
  /** The cached entry data */
  data: CachedEntryData;
  /**
   * Whether the caller should trigger background revalidation.
   * True when entry is stale AND not already being revalidated.
   * The store atomically marks the entry as REVALIDATING when returning true.
   */
  shouldRevalidate: boolean;
}

/**
 * Low-level segment cache store interface.
 *
 * Implementations handle the actual storage (memory, KV, Redis, etc.).
 * The store deals with serialized data - RSC serialization is handled
 * by the cache provider layer.
 *
 * @typeParam TEnv - Platform bindings type (e.g., Cloudflare env)
 */
export interface SegmentCacheStore<TEnv = unknown> {
  /**
   * The store honors getShell(..., { claimRevalidation: false }) without
   * claiming an SWR lock. Navigation replay requires this opt-in because it
   * cannot recapture an HTML shell after observing a stale entry.
   */
  readonly supportsPassiveShellReads?: true;

  /**
   * Default cache options for this store.
   * Used by cache() boundaries when ttl/swr are not explicitly specified.
   */
  readonly defaults?: CacheDefaults;

  /**
   * Custom key generator applied to all cache operations using this store.
   * Receives the full RequestContext and the default-generated key.
   * Return value becomes the final cache key (unless route overrides with `key` option).
   *
   * Resolution priority:
   * 1. Route-level `key` function (full override)
   * 2. Store-level `keyGenerator` (modifies default key)
   * 3. Default key generation (prefix:pathname:params)
   *
   * Return `defaultKey` unchanged to leave a request unpartitioned. An empty
   * string is not a key: where the result partitions a nested cache() on
   * another store, or a ppr shell, it fails key resolution, so the request
   * renders uncached (as when the keyGenerator throws), and the router warns
   * once naming the store.
   *
   * @example Using headers for cache segmentation
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const segment = ctx.request.headers.get('x-user-segment') || 'default';
   *   return `${segment}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using env bindings (Cloudflare)
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const region = ctx.env.REGION || 'us';
   *   return `${region}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using cookies for locale
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const locale = cookies().get('locale')?.value || 'en';
   *   return `${locale}:${defaultKey}`;
   * }
   * ```
   */
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;

  /**
   * Get cached entry data by key
   * @returns Cache result with data and staleness, null if not found/expired,
   * or CACHE_READ_ERROR when the read failed (optional — see the sentinel).
   */
  get(key: string): Promise<CacheGetResult | null | CacheReadError>;

  /**
   * Store entry data with TTL. Resolve once a later `get(key)` from the same
   * location observes the entry: the route cache() write runs in a background
   * task, and a PPR shell capture awaits that task before it reads the entry
   * back (#957). A store that resolves earlier makes the capture re-render
   * the page instead of replaying the entry.
   * @param key - Cache key
   * @param data - Serialized entry data
   * @param ttl - Time-to-live in seconds
   * @param swr - Optional stale-while-revalidate window in seconds
   */
  set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void>;

  /**
   * Delete a cached entry
   * @returns true if deleted, false if not found
   */
  delete(key: string): Promise<boolean>;

  /**
   * Clear all cached entries (optional, for testing)
   */
  clear?(): Promise<void>;

  /**
   * Get a cached Response by key.
   * Returns the response and whether it should be revalidated (SWR).
   */
  getResponse?(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null>;

  /**
   * Store a Response with TTL and optional SWR window.
   * @param key - Cache key
   * @param response - Response to cache (will be cloned)
   * @param ttl - Time-to-live in seconds
   * @param swr - Optional stale-while-revalidate window in seconds
   * @param tags - Optional cache tags for invalidation
   */
  putResponse?(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void>;

  /**
   * Get a cached PPR shell entry by key.
   * Returns the stored prelude/postponed pair (see ShellCacheEntry) and whether
   * it should be revalidated (SWR). Used by the shell-cache middleware to serve
   * a cached HTML shell and resume fizz for just the live holes.
   *
   * Optional: a store that does not implement the shell family disables the
   * shell-cache middleware (it fails open to the normal HTML render path).
   * A passive read reports a stale entry as `shouldRevalidate: true` without
   * claiming store-specific revalidation ownership.
   */
  getShell?(
    key: string,
    options?: { claimRevalidation?: boolean },
  ): Promise<{ entry: ShellCacheEntry; shouldRevalidate?: boolean } | null>;

  /**
   * Store a PPR shell entry with TTL and optional SWR window.
   * The prelude bytes and postponed state are version- and generation-coupled
   * and travel together in a single entry (they must never mix across a React
   * upgrade — the reactVersion field on the entry gates that at read time).
   * @param key - Cache key
   * @param entry - The shell prelude/postponed/version/createdAt bundle
   * @param ttlSeconds - Time-to-live in seconds: the route's `ppr.ttl`
   *   (undefined: the store's default), capped to the route cache() entry
   *   the capture replayed or wrote. A capped window arrives in whole
   *   seconds, rounded up, with ttl + swr at least 1; its ttl can be 0 (a
   *   shell stale from the start, captured from a record inside its swr
   *   window).
   * @param swrSeconds - Optional stale-while-revalidate window in seconds,
   *   under the same cap
   * @param tags - Optional cache tags for invalidation (participates in
   *   invalidateTags via the same tag machinery as the item family)
   * @returns `invalidated` when a generation marker rejected the write,
   *   `stored` when acknowledged, `uncacheable` when the entry can NEVER be
   *   stored under the current configuration (every retry would refuse
   *   identically — the capture scheduler backs the key off instead of
   *   recapturing per MISS; CFCacheStore returns it for a tag set whose
   *   Cache-Tag header overflows in KV-less purge mode), or void for stores
   *   without acknowledgements.
   */
  putShell?(
    key: string,
    entry: ShellCacheEntry,
    ttlSeconds?: number,
    swrSeconds?: number,
    tags?: string[],
  ): Promise<"stored" | "invalidated" | "uncacheable" | void>;

  /**
   * @internal The document serve path's shell read, for built-in stores. The
   * serve path prefers it over getShell: it resolves with the entry and the
   * raw (decoded) prelude, the snapshot on its own promise, and the read's
   * `debugPerformance` stats. CFCacheStore's layout keeps the snapshot behind
   * the prelude, so its HIT can commit before the snapshot is read;
   * VercelCacheStore reads the whole entry and decodes the prelude once per
   * memoized shell (issue #941, docs/design/shell-entry-layout.md). Not part
   * of the custom-store contract.
   */
  readShellDocument?(
    key: string,
    options?: ShellDocumentReadOptions,
  ): Promise<ShellDocumentRead | null>;

  /**
   * @internal How long (ms) this store's isolate memos (shell, tag markers)
   * can serve a read that predates a tag invalidation made elsewhere. After
   * updateTag()/revalidateTag(), the response's fresh-reads cookie lasts the
   * longest of these, and the same user's requests skip the memos meanwhile.
   * Absent or 0: nothing to cover.
   */
  readonly freshReadsWindowMs?: number;

  /**
   * @internal Drop this isolate's memoized copy of a shell (shell-memo.ts) so
   * the next read goes to the store. A HIT whose doc record failed to decode
   * calls it after replacing the entry with a tombstone: the memoized copy
   * holds the same record. Built-in stores only; not part of the custom-store
   * contract.
   */
  dropShellMemo?(key: string): void;

  /**
   * @internal The largest shell entry (prelude, postponed state, and snapshot
   * bytes) this store can hold in one value. The capture refuses a bigger
   * entry instead of letting the write fail inside waitUntil. Absent: the
   * capture applies DEFAULT_SHELL_ENTRY_MAX_BYTES (Cloudflare KV's 25 MiB).
   */
  readonly maxShellEntryBytes?: number;

  /**
   * Declares the shell family present-but-inert: getShell/putShell exist but
   * no-op (a custom store whose backing tier is conditionally unavailable).
   * scheduleShellCapture skips captures whose only write target is inert —
   * the background render would be dead work that still occupies the
   * per-isolate serialized capture queue (a promise-heavy route bakes for
   * seconds per MISS with nothing stored). Absent/false means the family,
   * when present, actually stores. The built-in stores never declare it:
   * CFCacheStore is L1-only without KV (edge-only ppr), not inert.
   */
  shellFamilyInert?: boolean;

  /**
   * Declares isTagsInvalidatedSince present-but-inert: the store implements
   * the method but has no DURABLE invalidation history behind it (a KV-less
   * CFCacheStore answers from the per-request memo at best). Runtime shells
   * tolerate that — purge eviction plus ttl/swr bound their staleness — but
   * a TAGGED build-manifest shell is immutable with no ttl of its own, so
   * serving it on such a store would make updateTag() a permanent no-op for
   * it. The build-shell read-through declines tagged entries on this flag
   * (same declared-intent-cannot-be-honored doctrine as a store missing the
   * method entirely). Absent/false means answers are durably backed.
   */
  tagHistoryInert?: boolean;

  /**
   * Get a cached function result by key.
   * Returns the serialized value, optional handle data, and staleness flag.
   */
  getItem?(key: string): Promise<CacheItemResult | null>;

  /**
   * Store a function result with TTL and optional SWR window.
   * @param key - Cache key (format: use-cache:{functionId}:{serializedArgs})
   * @param value - RSC-serialized return value
   * @param options - TTL, SWR, handle data, and tags
   */
  setItem?(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void>;

  /**
   * Invalidate every cache entry (segment, response, item) tagged with any of
   * `tags`. Store-level primitive that the public updateTag()/revalidateTag()
   * APIs delegate to. Receives ALL of one invalidation call's tags at once so
   * stores can batch their work (e.g. a single CDN purge request rather than
   * one per tag). Stores that do not support tags simply omit this method.
   *
   * Both verbs call it synchronously, inside the request that invalidates
   * (#973); revalidateTag() then hands the returned promise to waitUntil
   * without awaiting it. Read-your-own-writes for that request comes from
   * what the store does before its first await: record the tags as
   * invalidated in state its reads consult for the rest of the request (the
   * built-in stores key a map by the request's root context and the store,
   * so contexts derived from the request share it, and compare each hit's
   * tags and write time against it), then start the
   * durable write. Such a mask must only ever turn hits into misses, and only
   * in that request: a durable write that later fails then costs extra
   * misses, never a stale read. A store that records nothing before its
   * first await still works; the request that ran revalidateTag() can read
   * entries the invalidation covers until the durable write lands.
   * @param tags - The cache tags to invalidate
   */
  invalidateTags?(tags: string[]): Promise<void>;

  /**
   * True when ANY of `tags` was invalidated (invalidateTags/updateTag) at or
   * after `sinceMs` (>= so a same-millisecond invalidation wins, favouring
   * freshness). Consulted by build-shell read-through and runtime shell stores:
   * "was it evicted" is answered by tag markers against the entry's createdAt,
   * including when invalidation races a capture that has not been written yet.
   * Also the store's half of every cache write's gate (#977,
   * tag-invalidation.ts predatesInvalidation): a "use cache", loader cache(),
   * route cache() or document-cache write whose execution started before an
   * invalidation another isolate made is skipped when this answers true, so
   * it must reflect invalidations made after this request started reading
   * (not a value memoized earlier in the request).
   * Optional: without it, TAGGED build entries are not served (untagged ones
   * are unaffected — they are evictable only by deploy/buildVersion anyway),
   * and writes are gated by this isolate's invalidations only.
   * Fail open to `false` on marker-read errors: a transient store fault must
   * degrade to "still valid", the same posture as the envelope tag checks.
   * The write gate passes `{ failClosed: true }` instead: a marker it cannot
   * read (an error, a timed-out read) answers `true`, since a skipped write
   * only costs a later miss. A store that ignores the option still works;
   * its fault then lets that write through.
   */
  isTagsInvalidatedSince?(
    tags: string[],
    sinceMs: number,
    options?: { failClosed?: boolean },
  ): Promise<boolean>;
}

/**
 * Result from getItem() for function-level caching ("use cache").
 */
export interface CacheItemResult {
  /** RSC-serialized return value */
  value: string;
  /** RSC-encoded handle data captured during execution (breadcrumbs, metadata,
   *  etc.). Encoded via the Flight codec so Promise/ReactNode handle values
   *  survive JSON-serializing stores — see handle-snapshot.ts encodeHandles. */
  handles?: string;
  /** Whether the entry is stale and should be revalidated */
  shouldRevalidate: boolean;
  /**
   * The entry's cache tags (including runtime cacheTag() tags), surfaced on read
   * so a "use cache" HIT can still contribute its tags to the request-scoped tag
   * set used by document-level caching. On a hit the cached function is not
   * re-run, so its runtime tags are only available here, not from re-execution.
   */
  tags?: string[];
}

/**
 * A cached PPR (Partial Pre-rendering) shell entry.
 *
 * A DOCUMENT entry carries BOTH artifacts a resume needs — the rendered HTML
 * prelude and React's postponed state — because the pair is version- and
 * generation-coupled and must never be mixed across a React upgrade or a build
 * change. The reactVersion and buildVersion fields are the read-time gates that
 * enforce both halves: isValidShellHit (rsc/shell-serve.ts) treats an entry
 * whose reactVersion differs from the running React, or whose buildVersion
 * differs from the running build, as a miss (the postponed blob encodes hole
 * positions against one exact tree; resuming it against a different React or a
 * different app build tree-mismatches inside resume(), AFTER the 200 + prelude
 * are committed — an unrecoverable broken serve).
 *
 * A `navigationOnly` entry stores NEITHER half: nothing ever serves its HTML
 * (document serving skips navigationOnly entries at the read gate, and partial
 * replay consumes only `snapshot`/`docKey`), so the prelude would ride every
 * store write and read as dead weight at KV-value scale. The capture still runs
 * the full fizz prerender — it is the completeness arbiter and sanity gate —
 * but its output is dropped before putShell. hasIntactShellPayload is the
 * document-half gate; navigationOnly entries never satisfy it.
 */
export interface ShellCacheEntry {
  /**
   * Rendered HTML prelude bytes, base64-encoded (stores are JSON-serializing).
   * Absent on `navigationOnly` entries (no document half is stored — see the
   * interface doc); present on every document-servable entry.
   */
  prelude?: string;
  /**
   * JSON.stringify of React's postponed state, or null when the shell settled
   * with no holes (the DATA variant — served without a fizz resume). Absent
   * exactly when `prelude` is (navigationOnly entries).
   */
  postponed?: string | null;
  /** React.version captured at prerender time; the read-time invalidation gate. */
  reactVersion: string;
  /**
   * Build version captured at prerender time (the RSC handler's `version` —
   * the `@rangojs/router:version` build stamp by default, bumped per build and
   * on dev RSC-module edits). The second read-time gate: a persistent shared
   * store (KV/runtime-cache) survives deploys, and an app-code change that
   * keeps the same React version would otherwise leave a stale-build
   * prelude+postponed live under the same key. A custom store returns it as
   * putShell received it.
   */
  buildVersion: string;
  /**
   * The initialTheme the CAPTURE render was built with: the no-cookie default
   * (payloadInitialTheme, rsc/full-payload.ts), never the capturing visitor's
   * theme (#971). The resume tail must render ThemeProvider with the SAME
   * initialTheme the frozen prelude was rendered with: React resume requires the
   * tree above the holes to match the prerendered tree, and initialTheme is
   * per-request METADATA, not part of the cached segments — a visitor whose
   * theme differs from the capture's would otherwise produce a divergent resume
   * tree (broken stitching/hydration). The visitor's real theme is applied
   * pre-paint by the FOUC script and re-synced from the cookie post-mount by
   * ThemeProvider.
   */
  initialTheme?: string;
  /**
   * The CAPTURE DATA SNAPSHOT, in stored/serialized form: the doc segment
   * record every HIT replays the handler layer from (`docKey`) and the
   * bake-lane loader pins (pruned to what a HIT reads, issue #941). Replaying
   * them on a HIT keeps the freshly rendered hydration payload equal to the
   * frozen prelude after the underlying cache entries have drifted; every
   * other read on a HIT, a hole's included, reads the store. Empty when the capture
   * recorded nothing (a prerender-served capture without bake-lane loaders,
   * a tombstone). A custom store returns it as putShell received it. See
   * docs/design/ppr-shell-resume.md ("the capture data snapshot").
   */
  snapshot: ShellSnapshotRecord[];
  /**
   * Records the capture dropped from `snapshot` because no reader of this
   * entry consumes them, by family (`loader:1`). Diagnostic only: the
   * HIT tail timing reports it next to the kept records. See
   * docs/design/shell-entry-layout.md ("Record only what a HIT reads").
   */
  prunedRecords?: string;
  /**
   * The key of the document segment record inside `snapshot`: the handler
   * layer every HIT replays (a document HIT tail looks the record up by this
   * key, so a store keyGenerator or a build-time capture host cannot send it
   * elsewhere) and the record navigation replay consumes (resolved under the
   * implicit doc namespace at capture; see CacheScope.cacheRoute). A capture
   * that ran handlers always stores it; only a prerender-served entry (the
   * prerender store supplies the handler layer) has none. A document entry
   * without it is served as a MISS.
   */
  docKey?: string;
  /**
   * The entry was captured from a partial request only to produce an eligible
   * segment snapshot. Document serving must treat its HTML prelude as a miss;
   * the partial request's headers and middleware state are not document state.
   */
  navigationOnly?: true;
  /** Capture-generation start time; tag invalidations at or after it win. */
  createdAt: number;
}

/**
 * @internal A shell entry without its prelude and snapshot: what a
 * prelude-first read (SegmentCacheStore.readShellDocument) resolves with
 * before the snapshot bytes arrive.
 */
export type ShellEntryHead = Omit<ShellCacheEntry, "prelude" | "snapshot">;

/**
 * A shell entry whose document half is present — what the document HIT path
 * (serveShellHit / lookupBuildShell) consumes. hasIntactShellPayload
 * (rsc/shell-serve.ts) is the runtime gate AND the type narrowing to this
 * shape; navigationOnly entries never pass it (their document half is not
 * stored).
 */
export type DocumentShellCacheEntry = ShellCacheEntry & {
  prelude: string;
  postponed: string | null;
};

/** @internal Options of {@link SegmentCacheStore.readShellDocument}. */
export interface ShellDocumentReadOptions {
  /**
   * Tag names the route declares for its shell (`ppr.tags`), known before the
   * entry is read: their marker reads can start alongside the entry read.
   */
  tagHints?: readonly string[];
}

/**
 * @internal Why a prelude-first read's snapshot is missing although the entry
 * stored one: `unavailable` (the read timed out or failed; the entry may be
 * sound) or `corrupt` (the bytes arrived and do not parse; the store evicted
 * the entry).
 */
export type ShellSnapshotFailure = "unavailable" | "corrupt";

/**
 * @internal Result of {@link SegmentCacheStore.readShellDocument}.
 */
export interface ShellDocumentRead {
  /** The entry without its prelude and snapshot (delivered separately). */
  entry: ShellEntryHead;
  /** Raw prelude bytes (empty for a navigationOnly entry). */
  prelude: Uint8Array;
  shouldRevalidate?: boolean;
  /**
   * The capture snapshot, read after the prelude. Resolves undefined when the
   * entry has none or it could not be read (`snapshotFailure` says which); a
   * document HIT then cannot replay its doc record and degrades
   * (rsc-rendering.ts serveShellHit).
   * Never rejects.
   */
  snapshot: Promise<ShellSnapshotRecord[] | undefined>;
  /**
   * Why `snapshot` resolved undefined although the entry stored one, or
   * undefined when it did not fail. A document HIT that cannot replay its
   * doc record replaces the entry only when it is broken, not when its read
   * was merely slow (rsc-rendering.ts serveShellHit). Never rejects.
   */
  snapshotFailure?: Promise<ShellSnapshotFailure | undefined>;
  /**
   * Where the read's time and bytes went, for the `debugPerformance` metrics
   * (rsc-rendering.ts) and the store's own debug trace. Present only when one
   * of them is on for the request.
   */
  stats?: ShellReadStats;
}

/**
 * @internal Sub-steps of a prelude-first shell read. Times are ms. workerd
 * advances its clock only on I/O, so a CPU-only field
 * (`snapshot.parseMs`) reads 0 on a deployed worker: the byte counts are the
 * cost signal there.
 */
export interface ShellReadStats {
  /**
   * The tier that answered: `memo` (the store's shell memo), `l1`/`kv`
   * (CFCacheStore), or `store` (a single-tier store, VercelCacheStore).
   */
  tier: "memo" | "l1" | "kv" | "store";
  /** The per-isolate memo's outcome for this read and its size after it. */
  memo?: { hit: boolean; bytes: number };
  /**
   * A KV read after an L1 attempt: how long the L1 attempt took and why it
   * missed. The KV fields below then restart from the KV read.
   */
  l1MissMs?: number;
  l1MissReason?: string;
  /** Cache API match (L1) or KV get (KV) until the body was available. */
  matchMs?: number;
  /** Frame head read (I/O) and parse. */
  headMs?: number;
  /** Prelude bytes read. */
  preludeMs?: number;
  /** Tag-marker read, start to resolve (runs alongside the prelude read). */
  markerMs?: number;
  /** How long the read waited for the marker after the prelude was read. */
  markerWaitMs?: number;
  /**
   * The marker check was awaited after the entry read (VercelCacheStore), not
   * alongside the prelude read; hinted reads still start with the entry read.
   */
  markerSerial?: true;
  /**
   * How the isolate marker memo answered the shell's tags (the most
   * store-bound outcome across them): `fresh`, `stale` (served, refreshing in
   * the background), `read` (from the store), `bypass` (fresh-reads cookie).
   */
  markerMemo?: "fresh" | "stale" | "read" | "bypass";
  /** Tags whose marker reads were started before the entry's head (hints). */
  markerHinted?: readonly string[];
  /** When the hinted marker reads started (performance.now()). */
  markerHintStartedAt?: number;
  /** How many of the shell's tags were hinted. */
  markerHintHits?: number;
  /** How long the hinted marker reads ran before the entry named its tags. */
  markerLeadMs?: number;
  /** The request carried the fresh-reads cookie: no isolate memo was used. */
  freshReads?: true;
  headBytes?: number;
  preludeBytes?: number;
  /** Number of the shell's tags the marker read covered. */
  tags?: number;
  /** Filled after the commit, once the snapshot has been read. */
  snapshot?: { readMs: number; parseMs: number; bytes: number };
}

/**
 * The families a shell snapshot pins: the doc segment record (recorded by
 * RecordingShellStore) and the settled CONTAINER of each bake-lane loader
 * (lane rule: see resolveLoaderData, loader-cache.ts). No cache read is
 * pinned: a HIT's holes, and a bake-lane loader body that runs on the HIT,
 * read the store.
 */
export type ShellSnapshotFamily = "segment" | "loader";

/**
 * The stored form of a loader-family snapshot value: the bake-lane loader's
 * settled container, Flight-serialized AFTER eliding every still-pending nested
 * promise to a hole marker (the marker paths are holes, not shell material; on
 * a HIT the overlay re-slots the fresh run's promises there). Flight (not JSON)
 * so typed values (Date/Map) survive the round trip.
 */
export interface ShellSnapshotLoaderValue {
  /** RSC-serialized elided container (see loader-snapshot.ts). */
  value: string;
  /**
   * Hole bit, capture-computed (elide already walks every node): 1 = the
   * container carries hole markers, so a HIT must gate the overlay on the
   * fresh run (only the loader body can mint the live nested promises);
   * 0 = fully pinned, so a HIT resolves the payload promise immediately from
   * the pin and does not run the loader body (unless `runs`).
   */
  holes: 0 | 1;
  /**
   * 1 when the capture saw a loader push it could not record (a deferred
   * push, one with masked nested promises, or one made outside any loader
   * body): a HIT then still runs the loader body in the background
   * (pin-first) so those pushes reach the page. 0: a hole-free record is
   * served from the pin alone and its body does not run on a HIT.
   *
   * Both bits are always written. A record stored before they existed (v0.17)
   * reads each missing bit as 1 (buildShellLoaderSeed): its snapshot lacks
   * the loader-owned pushes, so the body supplies them.
   */
  runs: 0 | 1;
}

/**
 * One snapshot record: the doc segment record or a bake-lane loader pin.
 * `value` carries it in its stored/serialized shape so it round-trips
 * through a JSON-serializing store (KV, CF, Vercel) with the rest of the
 * ShellCacheEntry:
 * - `segment` -> {@link CachedEntryData} (already JSON-able)
 * - `loader`  -> {@link ShellSnapshotLoaderValue}
 */
export interface ShellSnapshotRecord {
  family: ShellSnapshotFamily;
  key: string;
  value: CachedEntryData | ShellSnapshotLoaderValue;
}

/**
 * Options for setItem() for function-level caching ("use cache").
 */
export interface CacheItemOptions {
  /** RSC-encoded handle data to store alongside the value (see encodeHandles). */
  handles?: string;
  /** Time-to-live in seconds */
  ttl?: number;
  /** Stale-while-revalidate window in seconds */
  swr?: number;
  /** Cache tags for invalidation */
  tags?: string[];
}

/**
 * Serialized segment data stored in cache
 * Note: loading is preserved to ensure consistent tree structure between cached and fresh renders
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface SerializedSegmentData {
  /** RSC-encoded component string */
  encoded: string;
  /** RSC-encoded layout string (if present) */
  encodedLayout?: string;
  /** RSC-encoded loading skeleton string (if present), or "null" for explicit null */
  encodedLoading?: string;
  /** RSC-encoded loaderData (if present) */
  encodedLoaderData?: string;
  /** RSC-encoded loaderDataPromise (if present) */
  encodedLoaderDataPromise?: string;
  /** Segment metadata (everything except component, layout, loading, and loader data) */
  metadata: Omit<
    ResolvedSegment,
    "component" | "layout" | "loading" | "loaderData" | "loaderDataPromise"
  >;
}

/**
 * Raw data stored in cache for an entry
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface CachedEntryData {
  /** Serialized segments for this entry */
  segments: SerializedSegmentData[];
  /** RSC-encoded handle data keyed by segment ID. Encoded via the Flight codec
   *  (see handle-snapshot.ts encodeHandles) so Promise/ReactNode handle values
   *  round-trip through JSON-serializing stores instead of being flattened. */
  handles: string;
  /**
   * Owning loader ids index-aligned with the decoded `handles` values
   * (HandleOwners). Absent: every value restores as a plain replay.
   */
  handleOwners?: HandleOwners;
  /** Expiration timestamp (ms since epoch) */
  expiresAt: number;
  /** Cache tags for invalidation */
  tags?: string[];
  /** Timestamp (ms since epoch) when tags were attached, for distributed invalidation */
  taggedAt?: number;
}

/**
 * Default cache options applied to all cache() boundaries.
 * Individual cache() calls can override any of these values.
 *
 * @example
 * ```ts
 * const store = new CFCacheStore({
 *   defaults: { ttl: 60, swr: 300 }
 * });
 * ```
 */
export interface CacheDefaults {
  /**
   * Default time-to-live in seconds.
   * After TTL expires, cached entry is considered stale.
   * Must be a finite, non-negative number; an invalid value (NaN/Infinity/
   * negative) falls back to the default at read time.
   */
  ttl?: number;
  /**
   * Default stale-while-revalidate window in seconds.
   * During SWR window, stale content is served while revalidating in background.
   * Must be a finite, non-negative number; an invalid value (NaN/Infinity/
   * negative) falls back to the default at read time.
   */
  swr?: number;
}

/**
 * Handle data for a single segment
 * Structure: { handleName: [values...] }
 */
export type SegmentHandleData = Record<string, unknown[]>;

/**
 * segmentId -> handleName -> the owning loader id of each recorded value, by
 * index (null: not owned). Only a PPR shell capture writes owners: the
 * settled pushes of the loader bodies it ran (an `ssr: false` loader's own,
 * the loaders it awaits, and its own cache() replays), which the record keeps
 * because the prelude rendered them. A restore of the record
 * (handle-snapshot.ts restoreHandles) keeps an owner's value where the
 * request serves that loader from the pin stored with the record
 * (HandleStore.pushRestored: it stands against a run of the loader), on a
 * document HIT and on a navigation replay alike. Every other owner's value
 * is a placeholder (pushPlaceholder): a live-lane loader's, and every
 * owner's where the record has no pin for it. The loader's run, or its own
 * cache() entry, replaces it.
 */
export type HandleOwners = Record<string, Record<string, (string | null)[]>>;
