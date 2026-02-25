/**
 * "use cache" Runtime
 *
 * Provides the runtime wrapper for functions marked with "use cache" directive.
 * The Vite transform plugin wraps exports with registerCachedFunction().
 *
 * On cache miss: executes the function, serializes the result via RSC Flight
 * protocol, captures handle data if tainted ctx is detected, and stores in
 * the SegmentCacheStore.
 *
 * On cache hit: deserializes the cached result, restores handle data if present.
 *
 * On stale hit: returns stale data immediately, triggers background
 * re-execution via waitUntil().
 */

/// <reference types="@vitejs/plugin-rsc/types" />

import {
  renderToReadableStream,
  createFromReadableStream,
  createTemporaryReferenceSet,
  encodeReply,
  createClientTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";
import { getRequestContext } from "../server/request-context.js";
import { isTainted } from "./taint.js";
import { getCacheProfile } from "./profile-registry.js";
import { streamToString, stringToStream } from "./segment-codec.js";
import type { SegmentHandleData } from "./types.js";
import type { HandleStore } from "../server/handle-store.js";

// ============================================================================
// Serialization Helpers
// ============================================================================

async function serializeResult(value: unknown): Promise<string | null> {
  try {
    const temporaryReferences = createTemporaryReferenceSet();
    const stream = renderToReadableStream(value, { temporaryReferences });
    return await streamToString(stream);
  } catch {
    return null;
  }
}

async function deserializeResult<T>(encoded: string): Promise<T> {
  const temporaryReferences = createTemporaryReferenceSet();
  const stream = stringToStream(encoded);
  return createFromReadableStream<T>(stream, { temporaryReferences });
}

// ============================================================================
// Cache Key Generation
// ============================================================================

/**
 * Convert encodeReply result to a stable string key.
 * encodeReply may return string or FormData — normalize to string.
 */
async function replyToCacheKey(encoded: string | FormData): Promise<string> {
  if (typeof encoded === "string") return encoded;
  // FormData: convert to Response body, then to string for deterministic key
  const text = await new Response(encoded).text();
  return text;
}

// ============================================================================
// Handle Capture
// ============================================================================

interface HandleCapture {
  data: Record<string, SegmentHandleData>;
}

function startHandleCapture(handleStore: HandleStore): HandleCapture {
  const capture: HandleCapture = { data: {} };
  const originalPush = handleStore.push.bind(handleStore);

  // Intercept push() calls to record them
  handleStore.push = (handleName: string, segmentId: string, value: unknown) => {
    if (!capture.data[segmentId]) {
      capture.data[segmentId] = {};
    }
    if (!capture.data[segmentId][handleName]) {
      capture.data[segmentId][handleName] = [];
    }
    capture.data[segmentId][handleName].push(value);
    // Still call the original so the data flows through normally
    originalPush(handleName, segmentId, value);
  };

  return capture;
}

function stopHandleCapture(handleStore: HandleStore, _capture: HandleCapture): void {
  // Restore original push by deleting the override
  // (the original is on the prototype/closure, our override is an own property)
  delete (handleStore as any).push;
}

function restoreHandles(
  handles: Record<string, SegmentHandleData>,
  handleStore: HandleStore,
): void {
  for (const [segId, segHandles] of Object.entries(handles)) {
    if (Object.keys(segHandles).length > 0) {
      handleStore.replaySegmentData(segId, segHandles);
    }
  }
}

// ============================================================================
// Core: registerCachedFunction
// ============================================================================

/**
 * Register a function as a cached function.
 * Called by the Vite transform for each "use cache" function.
 *
 * @param fn - The original async function
 * @param id - Stable identifier (module path + export name)
 * @param profileName - Cache profile name (from "use cache: profileName" or "default")
 */
export function registerCachedFunction<T extends (...args: any[]) => any>(
  fn: T,
  id: string,
  profileName: string,
): T {
  const wrapped = async function (this: any, ...args: any[]): Promise<any> {
    const requestCtx = getRequestContext();
    const store = requestCtx?._cacheStore;
    const profile = getCacheProfile(profileName || "default");

    // Bypass: no store, no getItem support, or no profile configured
    if (!store?.getItem || !profile) {
      return fn.apply(this, args);
    }

    // Separate tainted args (ctx, env, req) from key-generating args
    const keyArgs: unknown[] = [];
    let hasTaintedArgs = false;
    for (const arg of args) {
      if (isTainted(arg)) {
        hasTaintedArgs = true;
      } else {
        keyArgs.push(arg);
      }
    }

    // If tainted args are present, we need the handle store for capture/restore.
    // During late streaming (Suspense boundary resolution), ALS context may be
    // gone. Throw early rather than silently dropping handle side effects.
    if (hasTaintedArgs && !requestCtx?._handleStore) {
      throw new Error(
        `[use cache] "${id}" receives a tainted argument (ctx/env/req) but the ` +
        `HandleStore is not available. This typically happens when a "use cache" ` +
        `function with ctx runs outside the request context (e.g., during late ` +
        `streaming after AsyncLocalStorage context is lost). Move the "use cache" ` +
        `directive to a function that does not receive request-scoped objects, or ` +
        `use the route-level cache() DSL instead.`,
      );
    }

    // Generate cache key
    let cacheKey: string;
    try {
      if (keyArgs.length > 0) {
        const tempRefs = createClientTemporaryReferenceSet();
        const encoded = await encodeReply(keyArgs as unknown[], {
          temporaryReferences: tempRefs,
        });
        const argsKey = await replyToCacheKey(encoded);
        cacheKey = `use-cache:${id}:${argsKey}`;
      } else {
        cacheKey = `use-cache:${id}`;
      }
    } catch {
      // Non-serializable args: run uncached
      return fn.apply(this, args);
    }

    // Cache lookup
    const cached = await store.getItem(cacheKey);

    if (cached && !cached.shouldRevalidate) {
      // Fresh hit: deserialize and return
      try {
        const result = await deserializeResult(cached.value);
        // Restore handle data if present
        if (cached.handles && hasTaintedArgs) {
          const handleStore = requestCtx?._handleStore;
          if (handleStore) {
            restoreHandles(cached.handles, handleStore);
          }
        }
        return result;
      } catch {
        // Deserialization failed, fall through to fresh execution
      }
    }

    if (cached?.shouldRevalidate) {
      // Stale hit: return stale value, revalidate in background
      try {
        const result = await deserializeResult(cached.value);
        if (cached.handles && hasTaintedArgs) {
          const handleStore = requestCtx?._handleStore;
          if (handleStore) {
            restoreHandles(cached.handles, handleStore);
          }
        }
        // Background revalidation
        if (requestCtx?.waitUntil) {
          requestCtx.waitUntil(async () => {
            try {
              const freshResult = await fn.apply(this, args);
              const serialized = await serializeResult(freshResult);
              if (serialized !== null) {
                await store.setItem!(cacheKey, serialized, {
                  ttl: profile.ttl,
                  swr: profile.swr,
                  tags: profile.tags,
                });
              }
            } catch {
              // Background revalidation failed silently
            }
          });
        }
        return result;
      } catch {
        // Deserialization of stale value failed, fall through
      }
    }

    // Cache miss: execute, serialize, store
    const handleStore = hasTaintedArgs ? requestCtx?._handleStore : undefined;
    let capture: HandleCapture | undefined;
    if (handleStore && hasTaintedArgs) {
      capture = startHandleCapture(handleStore);
    }

    const result = await fn.apply(this, args);

    if (capture && handleStore) {
      stopHandleCapture(handleStore, capture);
    }

    // Serialize and store (non-blocking)
    try {
      const serialized = await serializeResult(result);
      if (serialized !== null) {
        const storePromise = store.setItem!(cacheKey, serialized, {
          handles: capture?.data,
          ttl: profile.ttl,
          swr: profile.swr,
          tags: profile.tags,
        });
        if (requestCtx?.waitUntil) {
          requestCtx.waitUntil(async () => { await storePromise; });
        }
      }
    } catch {
      // Serialization failed: return uncached
    }

    return result;
  };

  return wrapped as unknown as T;
}
