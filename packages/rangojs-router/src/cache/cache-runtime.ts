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
import {
  getRequestContext,
  runWithRequestContext,
} from "../server/request-context.js";
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
import {
  getDevelopmentDiagnosticLink,
  recordCacheTagObservationDiagnostic,
  recordLinkedCacheTagObservationDiagnostic,
  type CacheTagProvenance,
} from "../router/diagnostics/channel.js";

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
 * boundary-free token — `s:<value>` for strings, `b:<size>:<type>:<name>:<hash>`
 * for Blob/File (bytes folded via djb2 so distinct payloads of equal
 * size/type/name still differ). Strings carry an `s:` type tag so a string whose
 * value happens to equal a blob token (e.g. the literal `b:4::a:b:<hash>`) cannot
 * collide with an actual Blob/File entry under the same FormData key. The
 * user-controlled `type`/`name` are percent-encoded before joining so an embedded
 * `:` cannot shift the field boundaries and collide two distinct files (e.g.
 * {name:"a:b",type:""} vs {name:"b",type:":a"}). The result is stable across
 * identical arg sets.
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
      // Type-tag strings with `s:` so a string equal to a blob token (e.g.
      // `b:4::a:b:<hash>`) cannot collide with a Blob/File entry under the same
      // key (which carries the `b:` tag below).
      pairs.push([key, "s:" + value]);
    } else {
      // Blob/File: fold the bytes into a deterministic, boundary-free token.
      // Percent-encode the user-controlled type/name so an embedded `:` cannot
      // shift the `:`-delimited field boundaries and collide distinct files.
      const buf = await value.arrayBuffer();
      const hash = djb2HexBytes(new Uint8Array(buf));
      const name = "name" in value ? value.name : "";
      const encType = encodeURIComponent(value.type);
      const encName = encodeURIComponent(name);
      pairs.push([key, `b:${value.size}:${encType}:${encName}:${hash}`]);
    }
  }
  return encodeKV(pairs, { sort: true });
}

// Cached-fn ids already warned about running uncached under a test runner, so
// the test-ergonomics warning fires once per fn rather than once per call.
const warnedUncachedUnderTest = new Set<string>();

/**
 * Fast-path cache-key builder for JSON-safe key args. Returns a deterministic
 * string (object keys recursively sorted so insertion order can't change the
 * key) when EVERY part is a primitive or a plain object/array of the same, and
 * `undefined` otherwise so the caller falls back to the Flight reply encoder.
 *
 * Strings are always quoted via JSON.stringify, so they can never collide with
 * the bareword encodings of null/true/false/undefined/numbers. Anything the
 * reply encoder must handle instead — functions, symbols, bigint, non-finite
 * numbers, Dates, Maps, class instances, promises, and React elements (whose
 * `$$typeof` symbol value trips the symbol reject) — yields `undefined`.
 */
function jsonSafeKeyPart(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? String(value) : undefined;
    case "undefined":
      return "undefined";
    case "object": {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (const item of value) {
          const encoded = jsonSafeKeyPart(item);
          if (encoded === undefined) return undefined;
          parts.push(encoded);
        }
        return `[${parts.join(",")}]`;
      }
      // Only plain objects (Object.prototype or null proto) are fast-path safe.
      // Dates, Maps, class instances, promises, etc. carry a different prototype
      // and fall back to the encoder.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return undefined;
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const encoded = jsonSafeKeyPart(obj[key]);
        if (encoded === undefined) return undefined;
        parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      // bigint, symbol, function
      return undefined;
  }
}

/**
 * The serialized product of one "use cache" execution: exactly what the store
 * write persists. Followers that dedup onto an in-flight execution (see
 * inFlightExecutions) await this and serve it as a synthetic cache hit — each
 * deserializing its OWN copy of `serialized` and replaying `handles`/`tags`
 * against its OWN request. A deserialized result object is never shared.
 */
interface CacheEnvelope {
  /** RSC-serialized return value (never null — a null serialize rejects). */
  serialized: string;
  /** Merged profile/DSL + runtime cacheTag() tags. */
  tags: string[];
  /** RSC-encoded handle blob captured during execution, if any. */
  handles?: string;
}

/**
 * In-flight "use cache" executions keyed by cache key. When N concurrent calls
 * miss on the same key, only the first (the leader) runs the function; the rest
 * await its {@link CacheEnvelope} and serve it as a synthetic hit rather than
 * re-running the function and re-writing the store. Isolate-scoped (module
 * singleton), and cleared for a key as soon as the leader settles: a rejected
 * leader (function threw, or the result was not serializable) propagates to
 * current waiters, which then retry fresh.
 */
const inFlightExecutions = new Map<string, Promise<CacheEnvelope>>();

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
    const diagnosticLink = getDevelopmentDiagnosticLink();
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
      if (scoped.tags.size > 0) {
        recordCacheTagObservationDiagnostic({
          artifact: "function",
          phase: "bypass",
          provenance: ["runtime"],
          tags: scoped.tags,
          outcome: id,
        });
      }
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
          // Include user-facing search params (exclude internal _rsc*/__
          // params, plus the request's cache.searchParams filter -- same
          // normalization as the URL-keyed tiers).
          if (ctx.searchParams instanceof URLSearchParams) {
            const normalized = sortedSearchString(
              ctx.searchParams,
              requestCtx?._searchParamsFilter,
            );
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
        // Fast path: when every key arg is JSON-safe, build the key with a
        // deterministic stable-stringify and skip encodeReply (the Flight reply
        // encoder runs on EVERY call, including hits). The `:j:` namespace keeps
        // these keys disjoint from the encoder path so the two can never collide
        // for one fn id. Entries cached under the old encoder key for JSON-safe
        // args cold-start once after this upgrade.
        const fastKey = jsonSafeKeyPart(keyArgs);
        if (fastKey !== undefined) {
          cacheKey = `use-cache:${id}:j:${fastKey}`;
        } else {
          const tempRefs = createClientTemporaryReferenceSet();
          const encoded = await encodeReply(keyArgs as unknown[], {
            temporaryReferences: tempRefs,
          });
          const argsKey = await replyToCacheKey(encoded);
          cacheKey = `use-cache:${id}:${argsKey}`;
        }
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
      if (scoped.tags.size > 0) {
        recordCacheTagObservationDiagnostic({
          artifact: "function",
          phase: "bypass",
          provenance: ["runtime"],
          tags: scoped.tags,
          outcome: id,
        });
      }
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
    const serveCached = async (
      entry: CacheItemResult,
      phase: "hit" | "stale",
      recordStoredTags: boolean = true,
    ): Promise<any> => {
      const result = await deserializeResult(entry.value);
      if (entry.handles && hasTaintedArgs) {
        const handleStore = requestCtx?._handleStore;
        if (handleStore) {
          const r = await decodeHandles(entry.handles);
          if (r) restoreHandles(r, handleStore);
        }
      }
      recordRequestTags(entry.tags, requestCtx);
      if (recordStoredTags && entry.tags?.length) {
        recordCacheTagObservationDiagnostic({
          artifact: "function",
          phase,
          provenance: ["stored"],
          tags: entry.tags,
          identity: cacheKey,
          outcome: id,
        });
      }
      return result;
    };

    if (cached && !cached.shouldRevalidate) {
      // Fresh hit: deserialize and return
      try {
        return await serveCached(cached, "hit");
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

    // foregroundOnAction (opt-in; see CacheProfile.foregroundOnAction): during an
    // action's revalidation render, a stale entry falls through to the foreground
    // miss path below instead of SWR. The flag is set by revalidateAfterAction.
    const foregroundOnActionRevalidation =
      requestCtx?._inActionRevalidation === true &&
      profile.foregroundOnAction === true;
    if (cached?.shouldRevalidate && !foregroundOnActionRevalidation) {
      // Stale hit: return stale value, revalidate in background
      try {
        const result = await serveCached(cached, "stale");
        // Background revalidation — must capture handles if tainted args present.
        runBackground(requestCtx, async () => {
          // The background body runs under a DERIVED context with an OWN
          // _handleStore (the shell-capture isolation pattern —
          // shell-capture.ts attemptCapture): its handle pushes land in the
          // isolated store (captured below, persisted with the entry) while
          // the foreground keeps pushing into the ORIGINAL store, untouched.
          // Derivation matters because the foreground is STILL RENDERING here
          // — runBackground/waitUntil starts the task on the next microtask,
          // not after the response. The previous shape swapped
          // requestCtx._handleStore in place (restore in finally), which
          // routed the whole overlap window's foreground pushes into the
          // background store: lost from the live document AND persisted into
          // the revalidated entry (issue #684, plan 010).
          const bgHandleStore =
            hasTaintedArgs && requestCtx ? createHandleStore() : undefined;
          const bgCtx: typeof requestCtx = bgHandleStore
            ? Object.assign(Object.create(requestCtx), {
                _handleStore: bgHandleStore,
              })
            : requestCtx;
          let bgCapture: HandleCapture | undefined;
          let bgStopCapture: (() => void) | undefined;
          if (bgHandleStore) {
            const c = startHandleCapture(bgHandleStore);
            bgCapture = c.capture;
            bgStopCapture = c.stop;
          }

          // Tainted args are NOT stamped here, in contrast to the foreground
          // miss path below. The args include the live HandlerContext the
          // still-rendering foreground holds, and INSIDE_CACHE_EXEC is a
          // property stamped onto that SHARED object — so for the whole
          // revalidation window a concurrent foreground ctx.set() /
          // ctx.headers.*() would throw (issue #684, plan 010). requestCtx is
          // not stamped for the same reason. In-fn misuse is already caught
          // by the miss path's stamps on the function's FIRST execution — the
          // background re-runs the same function with the same request.

          try {
            // Re-establish the request-context ALS so a "use cache" body that
            // reads the ambient getRequestContext() (e.g.
            // getRequestContext().env.ApiKey) resolves during the background
            // revalidation instead of throwing "called outside of a request
            // context". runWithRequestContext sets the store for fn's
            // synchronous kickoff; its async continuations inherit it. The
            // DERIVED context goes in, so ambient _handleStore reads inside
            // the body resolve to the isolated store.
            const scoped = runWithRequestContext(bgCtx, () =>
              runWithCacheTagScope(() => fn.apply(this, args)),
            );
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
              if (diagnosticLink && freshTags.length > 0) {
                const provenance: CacheTagProvenance[] = [];
                if (profile.tags?.length) provenance.push("static-policy");
                if (scoped.tags.size > 0) provenance.push("runtime");
                recordLinkedCacheTagObservationDiagnostic(diagnosticLink, {
                  artifact: "function",
                  phase: "write",
                  provenance,
                  tags: freshTags,
                  identity: cacheKey,
                  outcome: id,
                });
              }
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
          }
          // No finally: nothing shared was mutated — the derived context and
          // its handle store are garbage after the task settles.
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

    // Cache miss.
    //
    // In-flight dedup: if a concurrent call for this key is already executing,
    // await its envelope and serve it as a synthetic hit rather than re-running
    // the function. Each follower deserializes its OWN copy, replays handles
    // against its OWN handle store (gated on ITS hasTaintedArgs), and records
    // tags into its OWN request — no deserialized result is shared across
    // requests. The store write stays exactly once (the leader's).
    const existing = inFlightExecutions.get(cacheKey);
    if (existing) {
      let envelope: CacheEnvelope | undefined;
      try {
        envelope = await existing;
      } catch {
        // Leader rejected (function threw or its result was not serializable);
        // its map entry is already cleared, so fall through to a fresh run.
        envelope = undefined;
      }
      if (envelope) {
        try {
          return await serveCached(
            {
              value: envelope.serialized,
              handles: envelope.handles,
              tags: envelope.tags,
              shouldRevalidate: false,
            },
            "hit",
            false,
          );
        } catch (error) {
          reportCacheError(
            error,
            "cache-corrupt",
            `[use cache] "${id}" inflight-hit`,
          );
          // Fall through to a fresh execution below.
        }
      }
    }

    // This call becomes the leader. Register a deferred envelope so concurrent
    // callers dedup onto it; it is resolved/rejected exactly once below (or on a
    // function throw). clearSelf only deletes the map slot if it still holds
    // THIS promise, so a fall-through retry (rare rejected-leader path) can't
    // evict a newer leader's entry.
    let resolveEnvelope!: (env: CacheEnvelope) => void;
    let rejectEnvelope!: (err: unknown) => void;
    const envelopePromise = new Promise<CacheEnvelope>((res, rej) => {
      resolveEnvelope = res;
      rejectEnvelope = rej;
    });
    // Followers attach their own catch; guard the map's own reference so a
    // rejected envelope with no waiter is not an unhandled rejection.
    envelopePromise.catch(() => {});
    inFlightExecutions.set(cacheKey, envelopePromise);
    const clearSelf = (): void => {
      if (inFlightExecutions.get(cacheKey) === envelopePromise) {
        inFlightExecutions.delete(cacheKey);
      }
    };

    // execute, serialize, store
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
    //
    // LOAD-BEARING for the stale-revalidation path above: the background
    // re-execution deliberately does NOT re-stamp (the objects are live
    // foreground state mid-render), relying on THIS stamp having caught in-fn
    // misuse on the function's first execution — an entry only becomes
    // stale-revalidatable because a stamped miss ran clean and stored it. Do
    // not create a "use cache" entry via any path that skips this stamp.
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
    } catch (execError) {
      // The function threw: drop the in-flight entry and reject any waiters so
      // they retry fresh, then propagate to this caller.
      clearSelf();
      rejectEnvelope(execError);
      throw execError;
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

    // Serialize + encode handles ONCE, resolve the in-flight envelope so any
    // concurrent followers can serve a synthetic hit, then persist to the store.
    // Fully non-blocking when waitUntil is available — the leader's response
    // waits on neither serialization nor the store write.
    const finalizeAndWrite = async (): Promise<void> => {
      let serialized: string | null;
      let encodedHandles: string | undefined;
      try {
        serialized = await serializeResult(result);
        encodedHandles = capture?.data
          ? await encodeHandles(capture.data)
          : undefined;
      } catch (buildError) {
        // Serialize/handle-encode failed: no envelope for followers (they run
        // fresh) and nothing to write.
        clearSelf();
        rejectEnvelope(buildError);
        requestCtx?._reportBackgroundError?.(buildError, "cache-write");
        return;
      }
      clearSelf();
      if (serialized === null) {
        if (diagnosticLink && allTags.length > 0) {
          const provenance: CacheTagProvenance[] = [];
          if (profile.tags?.length) provenance.push("static-policy");
          if (scoped!.tags.size > 0) provenance.push("runtime");
          recordLinkedCacheTagObservationDiagnostic(diagnosticLink, {
            artifact: "function",
            phase: "bypass",
            provenance,
            tags: allTags,
            outcome: id,
          });
        }
        // Non-serializable result: no store write (matches the prior silent
        // skip); reject so any waiter falls through to a fresh execution.
        rejectEnvelope(
          new Error(
            `[use cache] "${id}" result is not serializable; not cached`,
          ),
        );
        return;
      }
      // Hand followers the envelope before the store write so a slow/failed
      // write never stalls them.
      resolveEnvelope({ serialized, tags: allTags, handles: encodedHandles });
      try {
        await store.setItem!(cacheKey, serialized, {
          handles: encodedHandles,
          ttl: profile.ttl,
          swr: profile.swr,
          tags: allTags.length > 0 ? allTags : undefined,
        });
        if (diagnosticLink && allTags.length > 0) {
          const provenance: CacheTagProvenance[] = [];
          if (profile.tags?.length) provenance.push("static-policy");
          if (scoped!.tags.size > 0) provenance.push("runtime");
          recordLinkedCacheTagObservationDiagnostic(diagnosticLink, {
            artifact: "function",
            phase: "write",
            provenance,
            tags: allTags,
            identity: cacheKey,
            outcome: id,
          });
        }
      } catch (writeError) {
        requestCtx?._reportBackgroundError?.(writeError, "cache-write");
      }
    };

    await runBackground(requestCtx, finalizeAndWrite, true);

    return result;
  };

  // Brand the wrapper so it can be detected at runtime (e.g., to prevent
  // accidental use as middleware).
  (wrapped as any)[CACHED_FN_SYMBOL] = true;

  return wrapped as unknown as T;
}
