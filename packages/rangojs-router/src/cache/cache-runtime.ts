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
import { isUnderTestRunner } from "../runtime-env.js";
import {
  isTainted,
  CACHED_FN_SYMBOL,
  isCachedFunction,
  stampCacheExec,
  unstampCacheExec,
} from "./taint.js";

export { isCachedFunction };
import { serializeResult, deserializeResult } from "./segment-codec.js";
import { createHandleStore } from "../server/handle-store.js";
import {
  restoreHandles,
  encodeHandles,
  decodeHandles,
} from "./handle-snapshot.js";
import { startHandleCapture, type HandleCapture } from "./handle-capture.js";
import { sortedSearchString } from "./cache-key-utils.js";
import { encodeKV } from "../encode-kv.js";
import { runBackground } from "./background-task.js";
import {
  normalizeTags,
  recordRequestTags,
  runWithCacheTagScope,
} from "./cache-tag.js";
import { reportCacheError } from "./cache-error.js";
import type { CacheItemResult } from "./types.js";

/**
 * DJB2 hash returning an 8-char hex string. Deterministic across runtimes
 * (no crypto import — cache-runtime runs on the edge). Mirrors prerender's
 * param-hash djb2Hex so binary key parts hash consistently.
 */
function djb2HexBytes(bytes: Uint8Array): string {
  let hash = 5381;
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash << 5) + hash + bytes[i]!) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Convert encodeReply result to a stable string key.
 *
 * encodeReply may return a string or FormData. A plain string is already
 * deterministic for a given arg set, so return it verbatim. FormData (emitted
 * whenever a key arg is a typed array / Blob / File / a large object React
 * lazily chunks) carries a per-call RANDOM multipart boundary
 * (`formdata-undici-<random>`); stringifying the whole body via
 * `new Response(formData).text()` would therefore produce a DIFFERENT key on
 * every call, so the cached function would always miss and the store would
 * accumulate one duplicate entry per call (unbounded growth).
 *
 * Instead derive the key from the entries themselves, independent of the
 * boundary: iterate in sorted-key order and, for each value, emit a
 * boundary-free token — `value` for strings, `b:<size>:<type>:<name>:<hash>`
 * for Blob/File (bytes folded via djb2 so distinct payloads of equal
 * size/type/name still differ). The result is stable across identical arg sets.
 */
export async function replyToCacheKey(
  encoded: string | FormData,
): Promise<string> {
  if (typeof encoded === "string") return encoded;

  // Snapshot entries synchronously (forEach avoids relying on FormData's
  // iterator typings), then fold any Blob/File bytes asynchronously.
  const raw: [string, FormDataEntryValue][] = [];
  encoded.forEach((value, key) => {
    raw.push([key, value]);
  });
  const pairs: [string, string][] = [];
  for (const [key, value] of raw) {
    if (typeof value === "string") {
      pairs.push([key, value]);
    } else {
      // Blob/File: fold the bytes into a deterministic, boundary-free token.
      const buf = await value.arrayBuffer();
      const hash = djb2HexBytes(new Uint8Array(buf));
      const name = "name" in value ? value.name : "";
      pairs.push([key, `b:${value.size}:${value.type}:${name}:${hash}`]);
    }
  }
  return encodeKV(pairs, { sort: true });
}

// Cached-fn ids already warned about running uncached under a test runner, so
// the test-ergonomics warning fires once per fn rather than once per call.
const warnedUncachedUnderTest = new Set<string>();

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

    // Bypass: no store or no getItem support. Still run inside a tag scope so a
    // cacheTag() call inside the function degrades to a no-op rather than
    // throwing "must be called inside a use cache function" - adopting cacheTag()
    // must not hard-fail in apps/tests without an item-capable cache configured.
    // Note: the INSIDE_CACHE_EXEC guard (cookies()/headers()/ctx.set() rejection)
    // is intentionally NOT stamped here. It is a cached-path-only check; in the
    // bypass the body actually executes, so the guarded side effects take effect
    // and nothing is lost on a (non-existent) hit. Same applies to the
    // non-serializable-args bypass below.
    if (!store?.getItem) {
      // Test-ergonomics guard: under a test runner, a "use cache" function that
      // executes with no item-capable store seeded is exercising the UNCACHED
      // path — a green test that proves nothing about caching. Warn once per fn
      // id so the author knows to seed a cacheStore. Advisory (never throws), so
      // a test that DELIBERATELY runs uncached is unaffected. Gated on the test
      // runner (process.env.VITEST, not folded) so production never evaluates it.
      if (isUnderTestRunner() && !warnedUncachedUnderTest.has(id)) {
        warnedUncachedUnderTest.add(id);
        console.warn(
          `[rango] "use cache" function "${id}" executed but no cacheStore was ` +
            `seeded; the cached path is NOT under test (it ran uncached). Pass ` +
            `{ cacheStore, cacheProfiles } to runLoader/runMiddleware/renderHandler/` +
            `runInRequestContext (or configure createRouter({ cache }) for dispatch) ` +
            `to exercise it.`,
        );
      }
      const scoped = runWithCacheTagScope(() => fn.apply(this, args));
      const result = await scoped.result;
      // Still record the runtime tags into the request set so a cacheTag() in an
      // uncached function tags the document, even with no item-capable store.
      recordRequestTags(scoped.tags, requestCtx);
      return result;
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
          // Include host to prevent cross-host cache collisions (same
          // pattern as route-level cache-scope.ts key generation).
          if (ctx.url?.host) {
            keyArgs.push(ctx.url.host);
          }
          // Include route name to prevent collisions when the same cached
          // function is reused across routes with identical pathname/params
          // but different local reverse() scope.
          if (ctx._routeName) {
            keyArgs.push(ctx._routeName);
          }
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
      // Non-serializable args: run uncached (within a tag scope so cacheTag()
      // still does not throw). Record runtime tags so the document union still
      // sees them even though this call is not itself cached.
      const scoped = runWithCacheTagScope(() => fn.apply(this, args));
      const result = await scoped.result;
      recordRequestTags(scoped.tags, requestCtx);
      return result;
    }

    // Cache lookup
    const cached = await store.getItem(cacheKey);

    // Serve a cached entry on the hit path: deserialize the stored value,
    // replay handle data (gated on tainted args), and surface the entry's tags
    // to the request set (the function did not re-run, so its runtime cacheTag()
    // tags are only available from the stored entry). Shared by the fresh-hit
    // and stale-hit branches; the only divergence is the stale branch scheduling
    // background revalidation, which it does after this returns.
    const serveCached = async (entry: CacheItemResult): Promise<any> => {
      const result = await deserializeResult(entry.value);
      if (entry.handles && hasTaintedArgs) {
        const handleStore = requestCtx?._handleStore;
        if (handleStore) {
          const r = await decodeHandles(entry.handles);
          if (r) restoreHandles(r, handleStore);
        }
      }
      recordRequestTags(entry.tags, requestCtx);
      return result;
    };

    if (cached && !cached.shouldRevalidate) {
      // Fresh hit: deserialize and return
      try {
        return await serveCached(cached);
      } catch (error) {
        // The stored value is corrupt/partial (failed RSC deserialize). Report
        // it, then fall through to fresh execution - the miss path below re-runs
        // and setItem() overwrites the faulty entry under the same key (self-heal).
        reportCacheError(
          error,
          "cache-corrupt",
          `[use cache] "${id}" fresh-hit`,
        );
      }
    }

    if (cached?.shouldRevalidate) {
      // Stale hit: return stale value, revalidate in background
      try {
        const result = await serveCached(cached);
        // Background revalidation — must capture handles if tainted args present.
        // Use an isolated handle store so background pushes don't pollute the
        // live response or throw LateHandlePushError on the completed store.
        // Same isolation pattern as route-level background-revalidation.ts.
        runBackground(requestCtx, async () => {
          // Reuse closure-captured requestCtx instead of calling
          // getRequestContext() — ALS context may be gone inside waitUntil.
          let originalHandleStore:
            | ReturnType<typeof createHandleStore>
            | undefined;
          if (hasTaintedArgs && requestCtx) {
            originalHandleStore = requestCtx._handleStore;
            requestCtx._handleStore = createHandleStore();
          }
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

          // Stamp tainted ARGS only — not requestCtx. The args stamp guards
          // direct ctx method calls (ctx.set, ctx.header, ctx.onResponse, etc.)
          // which is sufficient for correctness.
          //
          // We intentionally skip stamping requestCtx here because:
          // 1. runBackground starts the async task synchronously (before the
          //    first await), so stampCacheExec would pollute the shared
          //    requestCtx while the foreground pipeline is still running.
          //    This causes assertNotInsideCacheExec to fire when cache-store
          //    later calls requestCtx.onResponse().
          // 2. requestCtx methods are closure-bound to the original ctx, so
          //    neither Object.create() nor a proxy can isolate the stamp.
          // 3. The foreground miss path already stamps requestCtx and catches
          //    cookies()/headers() misuse on first execution. The background
          //    re-runs the same function with the same request.
          const bgTaintedArgs: unknown[] = [];
          for (const arg of args) {
            if (isTainted(arg)) {
              stampCacheExec(arg as object);
              bgTaintedArgs.push(arg);
            }
          }

          try {
            const scoped = runWithCacheTagScope(() => fn.apply(this, args));
            const freshResult = await scoped.result;
            bgStopCapture?.();
            // Merge profile/DSL tags with runtime cacheTag() tags, read after
            // awaiting so post-await cacheTag() calls are included. Normalize
            // (drops empty profile tags, matching the invalidate path) + dedupe.
            const freshTags = [
              ...new Set(
                normalizeTags([...(profile.tags ?? []), ...scoped.tags]),
              ),
            ];
            recordRequestTags(freshTags, requestCtx);
            const serialized = await serializeResult(freshResult);
            if (serialized !== null) {
              const encodedHandles = bgCapture?.data
                ? await encodeHandles(bgCapture.data)
                : undefined;
              await store.setItem!(cacheKey, serialized, {
                handles: encodedHandles,
                ttl: profile.ttl,
                swr: profile.swr,
                tags: freshTags.length > 0 ? freshTags : undefined,
              });
            }
          } catch (bgError) {
            bgStopCapture?.();
            // Pass requestCtx explicitly: this runs in a detached background
            // task where the ALS context is gone, so onError can only fire if
            // we hand it the context captured up front.
            reportCacheError(
              bgError,
              "stale-revalidation",
              "[use cache] background revalidation failed",
              requestCtx,
            );
          } finally {
            for (const arg of bgTaintedArgs) {
              unstampCacheExec(arg as object);
            }
            // Restore original handle store
            if (originalHandleStore && requestCtx) {
              requestCtx._handleStore = originalHandleStore;
            }
          }
        });
        return result;
      } catch (error) {
        // Stale value is corrupt/partial; report and fall through to a fresh
        // execution, which overwrites the faulty entry under the same key.
        reportCacheError(
          error,
          "cache-corrupt",
          `[use cache] "${id}" stale-hit`,
        );
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
    // Uses ref-counted stamp/unstamp so overlapping executions
    // sharing the same ctx don't clear each other's guards.
    const taintedArgs: unknown[] = [];
    for (const arg of args) {
      if (isTainted(arg)) {
        stampCacheExec(arg as object);
        taintedArgs.push(arg);
      }
    }
    // Always stamp the ALS RequestContext so cookies()/headers() guards fire
    // even when the cached function receives no tainted args. The guard in
    // cookie-store.ts checks RequestContext, not function args.
    if (requestCtx) {
      stampCacheExec(requestCtx as object);
    }

    let result: any;
    let scoped: ReturnType<typeof runWithCacheTagScope>;
    try {
      scoped = runWithCacheTagScope(() => fn.apply(this, args));
      result = await scoped.result;
    } finally {
      // Decrement ref count; symbol is deleted when it reaches zero
      for (const arg of taintedArgs) {
        unstampCacheExec(arg as object);
      }
      if (requestCtx) {
        unstampCacheExec(requestCtx as object);
      }
      // Remove this capture token (order-independent, safe for concurrent use)
      stopCapture?.();
    }

    // Merge profile/DSL tags with runtime cacheTag() tags. Read scoped.tags
    // after awaiting result so post-await cacheTag() calls are included.
    // Normalize (drops empty profile tags, matching the invalidate path) + dedupe.
    const allTags = [
      ...new Set(normalizeTags([...(profile.tags ?? []), ...scoped!.tags])),
    ];
    recordRequestTags(allTags, requestCtx);

    // Serialize and store — fully non-blocking when waitUntil is available.
    // The response does not need to wait for serialization or the store write.
    const cacheWrite = async () => {
      try {
        const serialized = await serializeResult(result);
        if (serialized !== null) {
          const encodedHandles = capture?.data
            ? await encodeHandles(capture.data)
            : undefined;
          await store.setItem!(cacheKey, serialized, {
            handles: encodedHandles,
            ttl: profile.ttl,
            swr: profile.swr,
            tags: allTags.length > 0 ? allTags : undefined,
          });
        }
      } catch (writeError) {
        requestCtx?._reportBackgroundError?.(writeError, "cache-write");
      }
    };

    await runBackground(requestCtx, cacheWrite, true);

    return result;
  };

  // Brand the wrapper so it can be detected at runtime (e.g., to prevent
  // accidental use as middleware).
  (wrapped as any)[CACHED_FN_SYMBOL] = true;

  return wrapped as unknown as T;
}
