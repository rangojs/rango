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
  encodeReply,
  createClientTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";
import { getRequestContext } from "../server/request-context.js";
import {
  isTainted,
  CACHED_FN_SYMBOL,
  isCachedFunction,
  INSIDE_CACHE_EXEC,
} from "./taint.js";

export { isCachedFunction };
import { serializeResult, deserializeResult } from "./segment-codec.js";
import type { HandleStore } from "../server/handle-store.js";
import { restoreHandles } from "./handle-snapshot.js";
import { startHandleCapture, type HandleCapture } from "./handle-capture.js";

// ============================================================================
// Cache Key Generation
// ============================================================================

/**
 * Build a sorted, deterministic query string from URLSearchParams,
 * excluding internal _rsc* and __* params.
 */
function sortedSearchString(searchParams: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of searchParams) {
    if (!k.startsWith("_rsc") && !k.startsWith("__")) {
      pairs.push([k, v]);
    }
  }
  if (pairs.length === 0) return "";
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

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
    const resolvedProfileName = profileName || "default";

    // Bypass: no store or no getItem support
    if (!store?.getItem) {
      return fn.apply(this, args);
    }

    // Resolve profile strictly from request-scoped config (set by the
    // active router via createRequestContext). No global fallback —
    // global profile state is only for DSL-time cache("profileName").
    const profile = requestCtx?._cacheProfiles?.[resolvedProfileName];

    if (!profile) {
      throw new Error(
        `[use cache] "${id}" uses unknown cache profile "${resolvedProfileName}". ` +
          `Define it in createRouter({ cacheProfiles: { "${resolvedProfileName}": { ttl: ... } } }).`,
      );
    }

    // Separate tainted args (ctx, env, req) from key-generating args.
    // For tainted objects that carry route context (params, pathname,
    // searchParams), extract serializable values into the key so
    // different routes, param combinations, and query variants produce
    // distinct cache entries.
    const keyArgs: unknown[] = [];
    let hasTaintedArgs = false;
    for (const arg of args) {
      if (isTainted(arg)) {
        hasTaintedArgs = true;
        const ctx = arg as any;
        if (ctx.params && typeof ctx.params === "object") {
          keyArgs.push(ctx.pathname, ctx.params);
          if (ctx._responseType) {
            keyArgs.push(ctx._responseType);
          }
          // Include user-facing search params (exclude internal _rsc*/__ params)
          if (ctx.searchParams instanceof URLSearchParams) {
            const normalized = sortedSearchString(ctx.searchParams);
            if (normalized) {
              keyArgs.push(normalized);
            }
          }
        }
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
        // Background revalidation — must capture handles if tainted args present
        if (requestCtx?.waitUntil) {
          requestCtx.waitUntil(async () => {
            const bgHandleStore = hasTaintedArgs
              ? requestCtx?._handleStore
              : undefined;
            let bgCapture: HandleCapture | undefined;
            let bgStopCapture: (() => void) | undefined;
            if (bgHandleStore) {
              const c = startHandleCapture(bgHandleStore);
              bgCapture = c.capture;
              bgStopCapture = c.stop;
            }

            try {
              const freshResult = await fn.apply(this, args);
              bgStopCapture?.();
              const serialized = await serializeResult(freshResult);
              if (serialized !== null) {
                await store.setItem!(cacheKey, serialized, {
                  handles: bgCapture?.data,
                  ttl: profile.ttl,
                  swr: profile.swr,
                  tags: profile.tags,
                });
              }
            } catch {
              bgStopCapture?.();
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
    let stopCapture: (() => void) | undefined;
    if (handleStore && hasTaintedArgs) {
      const c = startHandleCapture(handleStore);
      capture = c.capture;
      stopCapture = c.stop;
    }

    // Stamp tainted args so ctx.set(), ctx.header(), etc. throw if called
    // inside the cached function body (those side effects are lost on hit).
    // Also stamp the ALS RequestContext so cookies()/headers() guards fire
    // (they read from getRequestContext(), which is a different object from
    // the HandlerContext/ResponseHandlerContext passed as args).
    const taintedArgs: unknown[] = [];
    for (const arg of args) {
      if (isTainted(arg)) {
        (arg as any)[INSIDE_CACHE_EXEC] = true;
        taintedArgs.push(arg);
      }
    }
    if (hasTaintedArgs && requestCtx) {
      (requestCtx as any)[INSIDE_CACHE_EXEC] = true;
    }

    let result: any;
    try {
      result = await fn.apply(this, args);
    } finally {
      // Always remove the flag, even if the function throws
      for (const arg of taintedArgs) {
        delete (arg as any)[INSIDE_CACHE_EXEC];
      }
      if (hasTaintedArgs && requestCtx) {
        delete (requestCtx as any)[INSIDE_CACHE_EXEC];
      }
      // Remove this capture token (order-independent, safe for concurrent use)
      stopCapture?.();
    }

    // Serialize and store — fully non-blocking when waitUntil is available.
    // The response does not need to wait for serialization or the store write.
    const cacheWrite = async () => {
      try {
        const serialized = await serializeResult(result);
        if (serialized !== null) {
          await store.setItem!(cacheKey, serialized, {
            handles: capture?.data,
            ttl: profile.ttl,
            swr: profile.swr,
            tags: profile.tags,
          });
        }
      } catch {
        // Serialization or store write failed silently
      }
    };

    if (requestCtx?.waitUntil) {
      requestCtx.waitUntil(cacheWrite);
    } else {
      // No waitUntil (e.g. Node.js dev server): run inline as best-effort
      await cacheWrite();
    }

    return result;
  };

  // Brand the wrapper so it can be detected at runtime (e.g., to prevent
  // accidental use as middleware).
  (wrapped as any)[CACHED_FN_SYMBOL] = true;

  return wrapped as unknown as T;
}
