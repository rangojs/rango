/**
 * Segment Cache Provider
 *
 * Creates cache providers that use pluggable storage backends.
 * Handles RSC serialization/deserialization of segment components.
 */

/// <reference types="@vitejs/plugin-rsc/types" />

import type { ResolvedSegment } from "../types.js";
import {
  renderToReadableStream,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";
import { createFromReadableStream } from "@vitejs/plugin-rsc/rsc";
import type {
  SegmentHandleData,
  CachedEntryResult,
  CachedEntryData,
  SerializedSegmentData,
  SegmentCacheProvider,
  SegmentCacheStore,
} from "./types.js";
import { getRequestContext } from "../server/request-context.js";

// Re-export types for convenience
export type { SegmentHandleData, CachedEntryResult, SegmentCacheProvider };

/**
 * Generate cache key for an entry with params
 */
function getSegmentCacheKey(
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
async function rscDeserialize<T>(encoded: string | undefined): Promise<T | undefined> {
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

    // Serialize the component to RSC stream
    const stream = renderToReadableStream(segment.component, {
      temporaryReferences,
    });

    // Convert stream to string
    const encoded = await streamToString(stream);

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
    const encodedLoaderDataPromise = await rscSerialize(loaderDataPromiseResolved);

    serialized.push({
      encoded,
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

    // RSC-deserialize loaderData and loaderDataPromise
    const loaderData = await rscDeserialize(item.encodedLoaderData);
    const loaderDataPromise = await rscDeserialize(item.encodedLoaderDataPromise);

    segments.push({
      ...item.metadata,
      component,
      loaderData,
      loaderDataPromise,
    } as ResolvedSegment);
  }

  return segments;
}

// Utility functions

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
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
 * Options for creating a segment cache provider
 */
export interface CreateSegmentCacheProviderOptions {
  /** Cache store implementation */
  store: SegmentCacheStore;
  /** Whether caching is enabled for this request (default: true) */
  enabled?: boolean;
  /** Default TTL in seconds (default: 60) */
  ttl?: number;
}

/**
 * Create a segment cache provider for use in request context.
 *
 * The provider handles RSC serialization/deserialization and delegates
 * storage to the provided cache store.
 *
 * @param options - Configuration options
 * @returns SegmentCacheProvider instance
 *
 * @example
 * ```typescript
 * import { MemorySegmentCacheStore } from "rsc-router/cache";
 *
 * // In handler.ts:
 * const store = new MemorySegmentCacheStore();
 * const cacheProvider = createSegmentCacheProvider({
 *   store,
 *   enabled: !url.searchParams.has("__no_cache"),
 *   ttl: 60
 * });
 *
 * const requestContext = createRequestContext({
 *   env, request, url, variables,
 *   cacheProvider
 * });
 * ```
 */
export function createSegmentCacheProvider(
  options: CreateSegmentCacheProviderOptions
): SegmentCacheProvider {
  const { store, enabled = true, ttl: defaultTtl = 60 } = options;

  // Internal get - not exposed on public interface
  async function get(
    entryId: string,
    params?: Record<string, string>
  ): Promise<CachedEntryResult | null> {
    if (!enabled) return null;

    const key = getSegmentCacheKey(entryId, params);

    try {
      const cached = await store.get(key);

      if (!cached) {
        console.log(`[SegmentCache] MISS: ${key}`);
        return null;
      }

      // Deserialize segments
      const segments = await deserializeSegments(cached.segments);

      const segmentTypes = segments.map((s) =>
        s.type === "parallel" ? s.slot : s.type
      );
      console.log(`[SegmentCache] HIT: ${key} (${segmentTypes.join(", ")})`);

      return {
        segments,
        handles: cached.handles,
      };
    } catch (error) {
      console.error(`[SegmentCache] Failed to get entry ${key}:`, error);
      return null;
    }
  }

  // Internal set - not exposed on public interface
  async function set(
    entryId: string,
    segments: ResolvedSegment[],
    handles: Record<string, SegmentHandleData>,
    ttl?: number
  ): Promise<void> {
    if (!enabled || segments.length === 0) return;

    // Use first segment's params for cache key
    const params = segments[0]?.params;
    const key = getSegmentCacheKey(entryId, params);

    try {
      // Serialize segments
      const serializedSegments = await serializeSegments(segments);

      const data: CachedEntryData = {
        segments: serializedSegments,
        handles,
        expiresAt: 0, // Store handles expiration
      };

      await store.set(key, data, ttl ?? defaultTtl);

      const segmentTypes = segments.map((s) =>
        s.type === "parallel" ? s.slot : s.type
      );
      console.log(`[SegmentCache] Cached: ${key} (${segmentTypes.join(", ")})`);
    } catch (error) {
      console.error(`[SegmentCache] Failed to cache entry ${key}:`, error);
    }
  }

  return {
    enabled,

    cacheEntry(cacheKey: string, segments: ResolvedSegment[]): void {
      if (!enabled || segments.length === 0) return;

      const requestCtx = getRequestContext();
      const handleStore = requestCtx?._handleStore;

      if (!handleStore || !requestCtx) return;

      requestCtx.waitUntil(async () => {
        await handleStore.settled;

        // Only cache if ALL segments have actual components (not null)
        // Null components mean client already has them - caching would break full renders
        const hasAllComponents = segments.every(
          (s) => s.component !== null || s.type === "loader"
        );
        if (!hasAllComponents) return;

        // Collect handle data for all segments
        const handles: Record<string, SegmentHandleData> = {};
        for (const seg of segments) {
          handles[seg.id] = handleStore.getDataForSegment(seg.id);
        }

        await set(cacheKey, segments, handles);
      });
    },

    async restore(
      cacheKey: string,
      params: Record<string, string>,
      loaderPromises: Map<string, Promise<any>>
    ): Promise<ResolvedSegment[] | null> {
      if (!enabled) return null;

      const cached = await get(cacheKey, params);
      if (!cached) return null;

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
      for (const seg of cached.segments) {
        if (seg.loaderId && seg.loaderData !== undefined) {
          loaderPromises.set(seg.loaderId, Promise.resolve(seg.loaderData));
        }
        if (seg.loaderIds && seg.loaderDataPromise) {
          const loaderData = seg.loaderDataPromise instanceof Promise
            ? await seg.loaderDataPromise
            : seg.loaderDataPromise;
          if (Array.isArray(loaderData)) {
            seg.loaderIds.forEach((id: string, i: number) => {
              loaderPromises.set(id, Promise.resolve(loaderData[i]));
            });
          }
        }
      }

      return cached.segments;
    },
  };
}
