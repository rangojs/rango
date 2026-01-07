/**
 * CacheScope - Runtime cache scope for iterator-based caching
 *
 * Each cache() boundary in the route tree creates a new CacheScope.
 * The scope owns: config, serialization, and storage operations.
 */

/// <reference types="@vitejs/plugin-rsc/types" />

import type { CacheOptions } from "../types.js";
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
 * Generate cache key for an entry with params
 */
function getCacheKey(
  entryId: string,
  params?: Record<string, string>
): string {
  const paramStr = params
    ? Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";
  return paramStr ? `${entryId}:${paramStr}` : entryId;
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

    segments.push({
      ...item.metadata,
      component,
      layout,
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
 */
export class CacheScope {
  readonly config: CacheOptions | false;
  readonly parent: CacheScope | null;

  constructor(config: CacheOptions | false, parent: CacheScope | null = null) {
    this.config = config;
    this.parent = parent;
  }

  /**
   * Whether caching is enabled for this scope
   */
  get enabled(): boolean {
    return this.config !== false;
  }

  /**
   * Get effective TTL (from config)
   */
  get ttl(): number {
    if (this.config === false) return 0;
    return this.config.ttl;
  }

  /**
   * Get SWR window (stale-while-revalidate)
   */
  get swr(): number | undefined {
    if (this.config === false) return undefined;
    return this.config.swr;
  }

  /**
   * Get the cache store from request context
   */
  private getStore(): SegmentCacheStore | null {
    const ctx = getRequestContext();
    return ctx?._cacheStore ?? null;
  }

  /**
   * Restore cached segments for an entry
   * Returns null if cache miss or caching disabled
   */
  async restore(
    entryId: string,
    params: Record<string, string>,
    loaderPromises: Map<string, Promise<any>>
  ): Promise<ResolvedSegment[] | null> {
    if (!this.enabled) return null;

    const store = this.getStore();
    if (!store) return null;

    const key = getCacheKey(entryId, params);

    try {
      const cached = await store.get(key);

      if (!cached) {
        console.log(`[CacheScope] MISS: ${key}`);
        return null;
      }

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

      // Restore loader data to loaderPromises for useLoader() support
      for (const seg of segments) {
        if (seg.loaderId && seg.loaderData !== undefined) {
          loaderPromises.set(seg.loaderId, Promise.resolve(seg.loaderData));
        }
        if (seg.loaderIds && seg.loaderDataPromise) {
          const loaderData =
            seg.loaderDataPromise instanceof Promise
              ? await seg.loaderDataPromise
              : seg.loaderDataPromise;
          if (Array.isArray(loaderData)) {
            seg.loaderIds.forEach((id: string, i: number) => {
              loaderPromises.set(id, Promise.resolve(loaderData[i]));
            });
          }
        }
      }

      const segmentTypes = segments.map((s) =>
        s.type === "parallel" ? s.slot : s.type
      );
      console.log(`[CacheScope] HIT: ${key} (${segmentTypes.join(", ")})`);

      return segments;
    } catch (error) {
      console.error(`[CacheScope] Failed to restore ${key}:`, error);
      return null;
    }
  }

  /**
   * Cache segments for an entry (non-blocking via waitUntil)
   */
  cacheEntry(cacheKey: string, segments: ResolvedSegment[]): void {
    if (!this.enabled || segments.length === 0) return;

    const store = this.getStore();
    if (!store) return;

    const requestCtx = getRequestContext();
    const handleStore = requestCtx?._handleStore;

    if (!handleStore || !requestCtx) return;

    const ttl = this.ttl;
    const params = segments[0]?.params;
    const key = getCacheKey(cacheKey, params);

    requestCtx.waitUntil(async () => {
      await handleStore.settled;

      // Only cache if ALL segments have actual components (not null)
      const hasAllComponents = segments.every(
        (s) => s.component !== null || s.type === "loader"
      );
      if (!hasAllComponents) return;

      // Collect handle data for all segments
      const handles: Record<string, SegmentHandleData> = {};
      for (const seg of segments) {
        handles[seg.id] = handleStore.getDataForSegment(seg.id);
      }

      try {
        // Serialize segments
        const serializedSegments = await serializeSegments(segments);

        const data: CachedEntryData = {
          segments: serializedSegments,
          handles,
          expiresAt: Date.now() + ttl * 1000,
        };

        await store.set(key, data, ttl);

        const segmentTypes = segments.map((s) =>
          s.type === "parallel" ? s.slot : s.type
        );
        console.log(`[CacheScope] Cached: ${key} (${segmentTypes.join(", ")}) ttl=${ttl}s`);
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
  config: { options: CacheOptions | false } | undefined,
  parent: CacheScope | null = null
): CacheScope | null {
  if (!config) return parent; // No config, inherit parent
  return new CacheScope(config.options, parent);
}
