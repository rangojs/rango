/**
 * CacheScope - Runtime cache scope for iterator-based caching
 *
 * Each cache() boundary in the route tree creates a new CacheScope.
 * The scope owns: config, serialization, and storage operations.
 */

/// <reference types="@vitejs/plugin-rsc/types" />

import type { PartialCacheOptions } from "../types.js";
import type { ResolvedSegment } from "../types.js";
import type {
  SegmentCacheStore,
  SegmentHandleData,
  CachedEntryData,
  SerializedSegmentData,
} from "./types.js";
import { getRequestContext } from "../server/request-context.js";
import {
  renderToReadableStream,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";
import { createFromReadableStream } from "@vitejs/plugin-rsc/rsc";

// ============================================================================
// Serialization Utilities
// ============================================================================

/**
 * Generate cache key for a route request
 * Single cache entry per route - uses pathname as the key
 * Includes request type prefix since they produce different segment sets:
 * - doc: document requests (full page load)
 * - partial: navigation requests (client-side navigation)
 * - intercept: intercept navigation (modal/overlay routes)
 */
function getRouteCacheKey(
  pathname: string,
  params?: Record<string, string>,
  isIntercept?: boolean
): string {
  const ctx = getRequestContext();
  const isPartial = ctx?.url.searchParams.has("_rsc_partial") ?? false;

  // Intercept navigations get their own cache namespace
  const prefix = isIntercept ? "intercept" : isPartial ? "partial" : "doc";

  const paramStr = params
    ? Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";

  const baseKey = paramStr ? `${pathname}:${paramStr}` : pathname;
  return `${prefix}:${baseKey}`;
}

async function streamToString(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  result += decoder.decode(); // flush
  return result;
}

function stringToStream(str: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const uint8 = encoder.encode(str);

  return new ReadableStream({
    start(controller) {
      controller.enqueue(uint8);
      controller.close();
    },
  });
}

/**
 * RSC-serialize a value (loaderData, etc.)
 */
async function rscSerialize(value: unknown): Promise<string | undefined> {
  if (value === undefined || value === null) return undefined;

  const temporaryReferences = createTemporaryReferenceSet();
  const stream = renderToReadableStream(value, { temporaryReferences });
  return streamToString(stream);
}

/**
 * RSC-deserialize a value
 */
async function rscDeserialize<T>(
  encoded: string | undefined
): Promise<T | undefined> {
  if (!encoded) return undefined;

  const temporaryReferences = createTemporaryReferenceSet();
  const stream = stringToStream(encoded);
  return createFromReadableStream<T>(stream, { temporaryReferences });
}

/**
 * Serialize segments for storage
 */
async function serializeSegments(
  segments: ResolvedSegment[]
): Promise<SerializedSegmentData[]> {
  const serialized: SerializedSegmentData[] = [];

  for (const segment of segments) {
    const temporaryReferences = createTemporaryReferenceSet();

    // Await component if it's a Promise (intercepts with loading keep component as Promise)
    const componentResolved =
      segment.component instanceof Promise
        ? await segment.component
        : segment.component;

    // Serialize the component to RSC stream
    const stream = renderToReadableStream(componentResolved, {
      temporaryReferences,
    });

    // Convert stream to string
    const encoded = await streamToString(stream);

    // RSC-serialize layout if present (ReactNode)
    const encodedLayout = segment.layout
      ? await rscSerialize(segment.layout)
      : undefined;

    // RSC-serialize loading if present (ReactNode) - preserves tree structure
    // Use "null" string to distinguish explicit null from undefined
    const encodedLoading =
      segment.loading !== undefined
        ? segment.loading === null
          ? "null"
          : await rscSerialize(segment.loading)
        : undefined;

    // Await and RSC-serialize loaderData if present
    const loaderDataResolved =
      segment.loaderData instanceof Promise
        ? await segment.loaderData
        : segment.loaderData;
    const encodedLoaderData = await rscSerialize(loaderDataResolved);

    // Await and RSC-serialize loaderDataPromise if present
    const loaderDataPromiseResolved =
      segment.loaderDataPromise instanceof Promise
        ? await segment.loaderDataPromise
        : segment.loaderDataPromise;
    const encodedLoaderDataPromise = await rscSerialize(
      loaderDataPromiseResolved
    );

    serialized.push({
      encoded,
      encodedLayout,
      encodedLoading,
      encodedLoaderData,
      encodedLoaderDataPromise,
      metadata: {
        id: segment.id,
        type: segment.type,
        namespace: segment.namespace,
        index: segment.index,
        params: segment.params,
        slot: segment.slot,
        belongsToRoute: segment.belongsToRoute,
        layoutName: segment.layoutName,
        parallelName: segment.parallelName,
        loaderId: segment.loaderId,
        loaderIds: segment.loaderIds,
      },
    });
  }

  return serialized;
}

/**
 * Deserialize segments from storage
 */
async function deserializeSegments(
  data: SerializedSegmentData[]
): Promise<ResolvedSegment[]> {
  const segments: ResolvedSegment[] = [];

  for (const item of data) {
    const temporaryReferences = createTemporaryReferenceSet();

    // Revive the component from cached string
    const stream = stringToStream(item.encoded);
    const component = await createFromReadableStream(stream, {
      temporaryReferences,
    });

    // RSC-deserialize layout, loaderData, loaderDataPromise in parallel
    const [layout, loaderData, loaderDataPromise] = await Promise.all([
      rscDeserialize(item.encodedLayout),
      rscDeserialize(item.encodedLoaderData),
      rscDeserialize(item.encodedLoaderDataPromise),
    ]);

    // Deserialize loading - "null" string means explicit null
    const loading = item.encodedLoading === "null" ? null : undefined;

    segments.push({
      ...item.metadata,
      component: await component,
      layout,
      loading,
      loaderData,
      loaderDataPromise,
    } as ResolvedSegment);
  }

  return segments;
}

// ============================================================================
// CacheScope
// ============================================================================

/**
 * CacheScope represents a cache boundary in the route tree.
 *
 * When withCache encounters an entry with cache config, it creates
 * a new CacheScope. The scope owns serialization, storage, and TTL.
 *
 * Store resolution priority:
 * 1. Explicit store in cache() options
 * 2. App-level store from handler config
 *
 * TTL resolution priority:
 * 1. Explicit value in cache() options
 * 2. Explicit store's defaults (if store specified)
 * 3. App-level store's defaults
 * 4. Hardcoded fallback (60 seconds)
 */
export class CacheScope {
  readonly config: PartialCacheOptions | false;
  readonly parent: CacheScope | null;
  /** Explicit store from cache() options, if specified */
  private readonly explicitStore: SegmentCacheStore | undefined;

  constructor(
    config: PartialCacheOptions | false,
    parent: CacheScope | null = null
  ) {
    this.config = config;
    this.parent = parent;
    // Extract and store explicit store reference
    this.explicitStore = config !== false ? config.store : undefined;
  }

  /**
   * Whether caching is enabled for this scope
   */
  get enabled(): boolean {
    return this.config !== false;
  }

  /**
   * Get effective TTL from config or store defaults
   */
  get ttl(): number {
    if (this.config === false) return 0;

    // Explicit TTL in cache() options
    if (this.config.ttl !== undefined) {
      return this.config.ttl;
    }

    // Fall back to store defaults (explicit store first, then app-level)
    const store = this.getStore();
    if (store?.defaults?.ttl !== undefined) {
      return store.defaults.ttl;
    }

    // Hardcoded fallback
    return 60;
  }

  /**
   * Get SWR window from config or store defaults
   */
  get swr(): number | undefined {
    if (this.config === false) return undefined;

    // Explicit SWR in cache() options
    if (this.config.swr !== undefined) {
      return this.config.swr;
    }

    // Fall back to store defaults
    const store = this.getStore();
    return store?.defaults?.swr;
  }

  /**
   * Get the cache store - resolution priority:
   * 1. Explicit store from cache() options
   * 2. App-level store from request context
   */
  private getStore(): SegmentCacheStore | null {
    // Explicit store from cache() options takes precedence
    if (this.explicitStore) {
      return this.explicitStore;
    }
    // Fall back to app-level store from request context
    const ctx = getRequestContext();
    return ctx?._cacheStore ?? null;
  }

  /**
   * Lookup cached segments for a route (single cache entry per request).
   * Returns { segments, shouldRevalidate } or null if cache miss.
   *
   * @param pathname - URL pathname for cache key generation
   * @param params - Route params for cache key generation
   * @param isIntercept - Whether this is an intercept navigation (uses different cache key)
   */
  async lookupRoute(
    pathname: string,
    params: Record<string, string>,
    isIntercept?: boolean
  ): Promise<{ segments: ResolvedSegment[]; shouldRevalidate: boolean } | null> {
    if (!this.enabled) return null;

    const store = this.getStore();
    if (!store) return null;

    const key = getRouteCacheKey(pathname, params, isIntercept);

    try {
      const result = await store.get(key);

      if (!result) {
        console.log(`[CacheScope] MISS: ${key}`);
        return null;
      }

      const { data: cached, shouldRevalidate } = result;

      // Deserialize segments
      const segments = await deserializeSegments(cached.segments);

      // Replay handle data
      const handleStore = getRequestContext()?._handleStore;
      if (handleStore) {
        for (const [segId, segHandles] of Object.entries(cached.handles)) {
          if (Object.keys(segHandles).length > 0) {
            handleStore.replaySegmentData(segId, segHandles);
          }
        }
      }

      const segmentTypes = segments.map((s) =>
        s.type === "parallel" ? s.slot : s.type
      );
      console.log(
        `[CacheScope] ${shouldRevalidate ? "STALE" : "HIT"}: ${key} (${segmentTypes.join(", ")})`
      );

      return { segments, shouldRevalidate };
    } catch (error) {
      console.error(`[CacheScope] Failed to lookup ${key}:`, error);
      return null;
    }
  }

  /**
   * Cache all segments for a route (non-blocking via waitUntil)
   * Single cache entry per route request.
   * Loaders are excluded - they're always fresh unless they have their own cache() config.
   *
   * @param pathname - URL pathname for cache key generation
   * @param params - Route params for cache key generation
   * @param segments - All resolved segments to cache
   * @param isIntercept - Whether this is an intercept navigation (uses different cache key)
   */
  cacheRoute(
    pathname: string,
    params: Record<string, string>,
    segments: ResolvedSegment[],
    isIntercept?: boolean
  ): void {
    if (!this.enabled || segments.length === 0) return;

    const store = this.getStore();
    if (!store) return;

    const requestCtx = getRequestContext();
    const handleStore = requestCtx?._handleStore;

    if (!handleStore || !requestCtx) return;

    // Exclude loader segments - loaders are always fresh by default
    // Loaders can opt-in to caching with their own cache() config
    const nonLoaderSegments = segments.filter((s) => s.type !== "loader");
    if (nonLoaderSegments.length === 0) return;

    const ttl = this.ttl;
    const key = getRouteCacheKey(pathname, params, isIntercept);

    // Check if this is a partial request (navigation) vs document request
    const isPartial = requestCtx.url.searchParams.has("_rsc_partial");

    requestCtx.waitUntil(async () => {
      await handleStore.settled;

      // For document requests: only cache if ALL segments have components (complete render)
      // For partial requests: null components are expected (client already has them)
      if (!isPartial) {
        const hasAllComponents = nonLoaderSegments.every(
          (s) => s.component !== null
        );
        if (!hasAllComponents) return;
      }

      // Collect handle data for non-loader segments only
      const handles: Record<string, SegmentHandleData> = {};
      for (const seg of nonLoaderSegments) {
        handles[seg.id] = handleStore.getDataForSegment(seg.id);
      }

      try {
        // Serialize non-loader segments only
        const serializedSegments = await serializeSegments(nonLoaderSegments);

        const data: CachedEntryData = {
          segments: serializedSegments,
          handles,
          expiresAt: Date.now() + ttl * 1000,
        };

        await store.set(key, data, ttl, this.swr);

        const segmentTypes = nonLoaderSegments.map((s) =>
          s.type === "parallel" ? s.slot : s.type
        );
        console.log(
          `[CacheScope] Cached: ${key} (${segmentTypes.join(", ")}) ttl=${ttl}s [loaders excluded]`
        );
      } catch (error) {
        console.error(`[CacheScope] Failed to cache ${key}:`, error);
      }
    });
  }
}

/**
 * Create a cache scope from entry's cache config
 */
export function createCacheScope(
  config: { options: PartialCacheOptions | false } | undefined,
  parent: CacheScope | null = null
): CacheScope | null {
  if (!config) return parent; // No config, inherit parent
  return new CacheScope(config.options, parent);
}
