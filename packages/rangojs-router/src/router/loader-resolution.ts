/**
 * Router Loader Resolution
 *
 * Loader execution, memoization, and error handling utilities.
 */

import type { ReactNode } from "react";
import type { EntryData } from "../server/context";
import { observePhase, PHASES } from "./instrument.js";
import { contextGet } from "../context-var.js";
import type {
  ResolvedSegment,
  HandlerContext,
  InternalHandlerContext,
  LoaderDefinition,
  LoaderContext,
  LoaderDataResult,
  ErrorBoundaryHandler,
  ErrorBoundaryFallbackProps,
  ErrorInfo,
  NotFoundBoundaryHandler,
  NotFoundBoundaryFallbackProps,
} from "../types";
import { createElement } from "react";
import { isDataNotFoundError } from "../errors.js";
import { isRedirectResponse } from "../response-utils.js";
import {
  resolveSoftRedirectUrl,
  getRedirectState,
  isExternalRedirect,
} from "../redirect-origin.js";
import {
  createNotFoundInfo,
  renderNotFoundFallback,
  resolveNotFoundFallback,
} from "./error-handling.js";
import { isHandle, collectHandleData, type Handle } from "../handle.js";
import { withDefer } from "../defer.js";
import {
  buildHandleSnapshot,
  type HandleStore,
} from "../server/handle-store.js";
import { getFetchableLoader } from "../server/fetchable-loader-store.js";
import { _getRequestContext } from "../server/request-context.js";
import {
  isInsideLoaderScope,
  runInsideLoaderBodyScope,
  isInsidePushCallbackScope,
  runInsidePushCallbackScope,
} from "../server/context.js";
import { debugLog } from "./logging.js";

/**
 * Internal callback signature for loader error notifications.
 * This is a simplified callback for internal use in wrapLoaderWithErrorHandling.
 * The caller (wrapLoaderPromise in router.ts) bridges this to the full OnErrorCallback.
 */
export type LoaderErrorCallback = (
  error: unknown,
  context: {
    segmentId: string;
    loaderName: string;
    handledByBoundary: boolean;
  },
) => void;

/**
 * Loader-thrown authority signals (notFound()/redirect()) are detected by the
 * shape a consumer can actually throw: DataNotFoundError via the shared
 * cross-realm-safe isDataNotFoundError, redirect by 3xx Response.
 */

/**
 * Deliver one `ctx.use(Handle)(value)` push to the owning segment.
 *
 * Shared by the handler lane (setupLoaderAccess) and the loader-body lane
 * (createLoaderExecutor) so a loader push attributes and scopes EXACTLY like a
 * handler push — that parity is the contract `ctx.use` in a loader promises.
 *
 * A function value runs inside the push-callback scope so `ctx.use(loader)`
 * calls it makes — including after its own awaits, for an async callback — are
 * not registered as handler-to-loader deps and do not trip the deadlock guard.
 * A pushed promise value is not tracked by handleStore.settled and does not
 * block segment resolution, so it cannot form a rendered() deadlock. The ALS
 * scope (not a plain boolean) is what survives the callback's awaits.
 */
function pushHandleValue(
  store: HandleStore | undefined,
  segmentId: string | undefined,
  handleId: string,
  dataOrFn: unknown | Promise<unknown> | (() => Promise<unknown>),
): void {
  if (!store || !segmentId) return;
  if (typeof dataOrFn === "function") {
    store.push(
      handleId,
      segmentId,
      runInsidePushCallbackScope(() => (dataOrFn as () => Promise<unknown>)()),
    );
    return;
  }
  store.push(handleId, segmentId, dataOrFn);
}

/**
 * Wrap a loader promise with error handling for deferred client-side resolution.
 * Catches errors and converts them to LoaderDataResult objects that include
 * error info and pre-rendered fallback UI when an error boundary is available.
 *
 * Loader-thrown SIGNALS are routed before error handling — they are control
 * flow, not failures (onError is not invoked for them):
 * - notFound(): the not-found UI is resolved and rendered HERE, server-side
 *   (nearest notFoundBoundary → router notFound option → default), exactly
 *   like the consumption lane (segment-resolution/helpers.ts), and rides the
 *   envelope's `fallback` — the client swaps with zero extra fetches. The
 *   response status is opportunistically set to 404 via the request stub: if
 *   the rejection settles before the document Response is constructed the
 *   status is a real 404; after, the stub write is inert (streamed fix-up
 *   only). Nav-lane payloads are 200 either way — the client owns 404
 *   presentation there.
 * - redirect() (thrown 3xx Response): the target is resolved through the
 *   soft-redirect same-origin rules NOW so unsafe targets never leave the
 *   server; the client navigates when the entry decodes. No document-lane
 *   302 — pre-stream redirect authority belongs to middleware (doctrine);
 *   a loader redirect is always a client-side navigate.
 *
 * @param onError - Optional callback invoked when loader errors occur.
 *   This has a simplified signature for internal use - the caller (typically
 *   wrapLoaderPromise in router.ts) is responsible for bridging to the full
 *   OnErrorCallback with complete request context (request, url, env, etc.).
 */
export function wrapLoaderWithErrorHandling<T>(
  promise: Promise<T>,
  entry: EntryData,
  segmentId: string,
  pathname: string,
  findNearestErrorBoundary: (
    entry: EntryData | null,
  ) => ReactNode | ErrorBoundaryHandler | null,
  createErrorInfo: (
    error: unknown,
    segmentId: string,
    segmentType: ErrorInfo["segmentType"],
  ) => ErrorInfo,
  onError?: LoaderErrorCallback,
  notFoundDeps?: {
    findNearestNotFoundBoundary: (
      entry: EntryData | null,
    ) => ReactNode | NotFoundBoundaryHandler | null;
    notFoundComponent?:
      | ReactNode
      | ((props: { pathname: string }) => ReactNode);
  },
): Promise<LoaderDataResult<T>> {
  // Extract the trailing token from segmentId (format: "<shortCode>D<i>.<loaderId>").
  // The token is the loader's $$id (hash#export in prod, pathfrag#export in dev),
  // not a clean display name.
  const loaderName = segmentId.split(".").pop() || "unknown";

  return Promise.resolve(promise)
    .then(
      (data): LoaderDataResult<T> => ({
        __loaderResult: true,
        ok: true,
        data,
      }),
    )
    .catch((error): LoaderDataResult<T> => {
      if (isDataNotFoundError(error)) {
        // Opportunistic document 404: the stub status is read once when the
        // document Response is constructed (createResponseWithMergedHeaders);
        // a pre-construction write becomes the real status, a later write is
        // harmless. Same mechanism as the consumption lane's setResponseStatus.
        _getRequestContext()?._setStatus(404);

        const effective = resolveNotFoundFallback(
          notFoundDeps?.findNearestNotFoundBoundary(entry),
          notFoundDeps?.notFoundComponent,
          pathname,
        );

        const notFoundInfo = createNotFoundInfo(
          error as { message: string },
          segmentId,
          "loader",
          pathname,
        );
        let renderedNotFound: ReactNode;
        try {
          renderedNotFound = renderNotFoundFallback(effective, notFoundInfo);
        } catch {
          // A throwing boundary must not collapse the envelope (the wrapped
          // promise is contracted to never reject); degrade to the default.
          // Deliberately NOT shared with the consumption lane
          // (segment-resolution/helpers.ts), which lets a throwing boundary
          // propagate to the error boundary — only this lane is contracted to
          // never reject.
          renderedNotFound = createElement("h1", null, "Not Found");
        }

        debugLog("loader", "loader threw notFound()", {
          segmentId,
          pathname,
        });

        return {
          __loaderResult: true,
          ok: false,
          notFound: true,
          error: createErrorInfo(error, segmentId, "loader"),
          fallback: renderedNotFound ?? null,
        };
      }

      if (error instanceof Response && isRedirectResponse(error)) {
        const reqCtx = _getRequestContext();
        const requestOrigin = reqCtx?.originalUrl?.origin ?? reqCtx?.url.origin;
        const location = error.headers.get("Location")!;
        // Same-origin policy applied server-side; the wire never carries an
        // unresolved target. redirect(url, { external: true })'s WeakSet brand
        // survives (the thrown Response IS the branded object).
        const to = requestOrigin
          ? resolveSoftRedirectUrl(
              location,
              requestOrigin,
              reqCtx?._basename,
              isExternalRedirect(error),
            )
          : location;

        debugLog("loader", "loader threw redirect()", {
          segmentId,
          to,
        });

        // redirect(url, { state }): the resolved state rides the thrown
        // Response (attachRedirectState), NOT payload metadata — a streaming
        // loader settles after the metadata flush, so the marker is the only
        // carrier that reaches the client. LoaderRedirect navigates with it.
        const redirectState = getRedirectState(error);

        return {
          __loaderResult: true,
          ok: false,
          redirect: { to, ...(redirectState && { state: redirectState }) },
          error: createErrorInfo(
            new Error(`Loader redirected to ${to}`),
            segmentId,
            "loader",
          ),
          fallback: null,
        };
      }

      // Find nearest error boundary
      const fallback = findNearestErrorBoundary(entry);

      // Create error info
      const errorInfo = createErrorInfo(error, segmentId, "loader");

      // Invoke onError callback if provided
      onError?.(error, {
        segmentId,
        loaderName,
        handledByBoundary: !!fallback,
      });

      if (!fallback) {
        // No error boundary - return error result without fallback
        // Client will throw this error
        return {
          __loaderResult: true,
          ok: false,
          error: errorInfo,
          fallback: null,
        };
      }

      // Render fallback on server. The user ErrorBoundaryHandler may throw
      // synchronously; if it does we must NOT let that rejection escape — the
      // wrapped LoaderDataResult promise is contracted to never reject (see
      // segment-resolution/fresh.ts `await Promise.all(...wrapped)`), and a
      // rejection here would collapse the whole entry and discard healthy
      // sibling loader data. On a fallback-render throw, fall back to the
      // no-boundary result (fallback: null) so the client throws the ORIGINAL
      // error, and the wrapped promise still resolves to a LoaderDataResult.
      let renderedFallback: ReactNode;
      try {
        if (typeof fallback === "function") {
          // ErrorBoundaryHandler - call with error info
          const props: ErrorBoundaryFallbackProps = {
            error: errorInfo,
          };
          renderedFallback = fallback(props);
        } else {
          renderedFallback = fallback;
        }
      } catch (fallbackError) {
        debugLog("loader", "error boundary fallback render threw", {
          segmentId,
          message: errorInfo.message,
          fallbackError:
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError),
        });
        return {
          __loaderResult: true,
          ok: false,
          error: errorInfo,
          fallback: null,
        };
      }

      debugLog("loader", "loader error wrapped with boundary fallback", {
        segmentId,
        message: errorInfo.message,
      });

      return {
        __loaderResult: true,
        ok: false,
        error: errorInfo,
        fallback: renderedFallback,
      };
    });
}

/**
 * Detect cycles in the loader dependency graph using DFS from a given node.
 * Returns the cycle path (array of loader IDs forming the cycle) if one exists,
 * or null if no cycle is found.
 */
function detectLoaderCycle(
  from: string,
  to: string,
  dependsOn: Map<string, Set<string>>,
): string[] | null {
  // If `to` can reach `from` via the dependency graph, adding the edge
  // from -> to creates a cycle. We search from `to` looking for `from`.
  const visited = new Set<string>();
  const path: string[] = [from, to];

  function dfs(current: string): string[] | null {
    if (current === from) {
      // Found a cycle: return the path leading back to `from`
      return path;
    }
    if (visited.has(current)) return null;
    visited.add(current);

    const deps = dependsOn.get(current);
    if (!deps) return null;

    for (const dep of deps) {
      path.push(dep);
      const cycle = dfs(dep);
      if (cycle) return cycle;
      path.pop();
    }
    return null;
  }

  return dfs(to);
}

/**
 * Creates a memoizing loader executor with cycle detection.
 * Shared by setupLoaderAccess and setupLoaderAccessSilent; only the handle
 * branch differs between the two, so only the loader logic is extracted here.
 *
 * Returns a useLoader(loader, callerLoaderId) function that:
 * - Tracks dependency edges between loaders for cycle detection
 * - Throws immediately (synchronously inside an async fn) on circular deps
 * - Memoizes each loader's promise so it runs at most once per request
 */
function createLoaderExecutor<TEnv>(
  ctx: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>,
  executorOptions?: {
    /**
     * Background proactive-caching mode: ctx.handle() pushes become no-ops
     * (mirroring setupLoaderAccessSilent's handler-handle no-op) and loader
     * bodies are NOT aux-tracked into the foreground handle store — a
     * background run must neither duplicate handle data nor extend the live
     * payload's handle-stream lifetime.
     */
    silentHandles?: boolean;
  },
): (
  loader: LoaderDefinition<any, any>,
  callerLoaderId: string | null,
) => Promise<any> {
  // Capture RequestContext eagerly for cookie access (ALS protection on Cloudflare)
  const reqCtxRef = _getRequestContext();
  const silentHandles = executorOptions?.silentHandles === true;

  // Dependency graph: loaderId -> set of loader IDs it directly depends on.
  const dependsOn = new Map<string, Set<string>>();

  // Loaders whose promises have not yet settled.
  // A dependency on a pending loader that closes a cycle means deadlock.
  const pendingLoaders = new Set<string>();

  function useLoader(
    loader: LoaderDefinition<any, any>,
    callerLoaderId: string | null,
  ): Promise<any> {
    // Record the dependency edge and check for cycles before running
    if (callerLoaderId !== null) {
      let deps = dependsOn.get(callerLoaderId);
      if (!deps) {
        deps = new Set();
        dependsOn.set(callerLoaderId, deps);
      }

      // Only relevant when the target is still pending (would deadlock)
      if (pendingLoaders.has(loader.$$id)) {
        const cycle = detectLoaderCycle(callerLoaderId, loader.$$id, dependsOn);
        if (cycle) {
          throw new Error(
            `Circular loader dependency detected: ${cycle.join(" -> ")}. ` +
              `Loaders cannot depend on each other in a cycle. ` +
              `Refactor to break the circular dependency.`,
          );
        }
      }

      deps.add(loader.$$id);
    }

    // Return cached promise if already started
    if (loaderPromises.has(loader.$$id)) {
      return loaderPromises.get(loader.$$id)!;
    }

    // Get loader function - either from loader object or fetchable registry
    let loaderFn = loader.fn;
    if (!loaderFn) {
      const fetchable = getFetchableLoader(loader.$$id);
      if (fetchable) {
        loaderFn = fetchable.fn;
      }
    }

    if (!loaderFn) {
      throw new Error(
        `Loader "${loader.$$id}" has no function. This usually means the loader was defined without "use server" and the function was not included in the build.`,
      );
    }

    pendingLoaders.add(loader.$$id);

    const currentLoaderId = loader.$$id;
    const variables = (ctx as InternalHandlerContext<any, TEnv>)._variables;

    // Capture whether this loader is being started from a DSL loader scope
    // (runInsideLoaderScope in fresh.ts). Handler-invoked loaders are NOT
    // inside loader scope. This determines whether rendered() is allowed.
    const isDslLoader = isInsideLoaderScope();

    // Owning segment for ctx.handle() attribution, captured SYNCHRONOUSLY at
    // kickoff: segment resolution sets _currentSegmentId while resolving the
    // segment that declares this loader (fresh.ts), and the value moves on as
    // resolution continues — by the time the async body pushes, it would be
    // stale. Attributing to the owning route/layout segment gives handle
    // pushes the same granularity handler pushes have (segmentOrder-correct
    // for breadcrumb accumulation).
    const owningSegmentId = (ctx as InternalHandlerContext<any, TEnv>)
      ._currentSegmentId;

    let renderedResolved = false;
    let renderedPromise: Promise<void> | null = null;

    // Loader functions are always fresh (never cached), so they get an
    // unguarded get that bypasses non-cacheable read guards. This applies
    // to ALL loaders — DSL and handler-called — because the loader
    // function itself always re-executes. Also handles nested deps
    // (loaderA → use(loaderB)) since all share this unguarded get.
    const loaderCtx: LoaderContext<Record<string, string | undefined>, TEnv> = {
      params: ctx.params,
      routeParams: (ctx.params ?? {}) as Record<string, string>,
      request: ctx.request,
      searchParams: ctx.searchParams,
      search: (ctx as any).search,
      pathname: ctx.pathname,
      url: ctx.url,
      originalUrl: ctx.originalUrl,
      env: ctx.env,
      waitUntil: ctx.waitUntil.bind(ctx),
      executionContext: ctx.executionContext,
      get: ((keyOrVar: any) => {
        // Handle READ (moved from ctx.use(handle)): collected data, available
        // after `await ctx.rendered()` — the rendered-barrier contract.
        if (isHandle(keyOrVar)) {
          if (!renderedResolved) {
            throw new Error(
              `ctx.get(handle) in a loader requires "await ctx.rendered()" first. ` +
                `Handle "${keyOrVar.$$id}" cannot be read until the render tree has settled.`,
            );
          }
          const reqCtx = reqCtxRef ?? _getRequestContext();
          if (!reqCtx) {
            throw new Error(
              `ctx.get(handle) failed: request context not available.`,
            );
          }
          const segmentOrder = reqCtx._renderBarrierSegmentOrder ?? [];
          // The complete snapshot is cached at barrier resolution for
          // non-streaming trees, and by rendered() after handleStore.settled for
          // streaming trees (where the eager snapshot would have been incomplete
          // because loading() handlers were still in flight). Either way it is
          // present by the time a loader reads a handle; the fresh build is only
          // a defensive fallback.
          const snapshot =
            reqCtx._renderBarrierHandleSnapshot ??
            buildHandleSnapshot(reqCtx._handleStore, segmentOrder);
          return collectHandleData(keyOrVar, snapshot, segmentOrder);
        }
        return contextGet(variables, keyOrVar);
      }) as typeof ctx.get,
      use: ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
        if (isHandle(item)) {
          // Handle WRITE — handler parity: `ctx.use(Meta)({...})` pushes from
          // the loader body exactly like a handler push. Reads moved to
          // ctx.get(handle) (rendered()-gated). Pushes attribute to the OWNING
          // segment and are legal for the whole body: the body is tracked on
          // the handle store's auxiliary lane, so the store stays open past
          // the handler barrier. Delivery follows the race: pushes that beat
          // the handler barrier ride the SSR snapshot, later ones stream via
          // metadata.handlesLate (document) or the still-open handles
          // generator (nav/action lanes).
          const handleDef = item;
          if (silentHandles) {
            return withDefer((_dataOrFn: unknown) => {});
          }
          const store =
            reqCtxRef?._handleStore ?? _getRequestContext()?._handleStore;
          const segmentId = owningSegmentId;
          return withDefer(
            (
              dataOrFn: unknown | Promise<unknown> | (() => Promise<unknown>),
            ) => {
              pushHandleValue(store, segmentId, handleDef.$$id, dataOrFn);
            },
          );
        }

        // Loader case
        return useLoader(item as LoaderDefinition<any, any>, currentLoaderId);
      }) as LoaderContext["use"],
      method: "GET",
      body: undefined,
      reverse: ctx.reverse as LoaderContext["reverse"],
      rendered: (): Promise<void> => {
        // Guard: only DSL loaders may use rendered()
        if (!isDslLoader) {
          throw new Error(
            `ctx.rendered() is only available in DSL loaders (registered via loader() in urls()). ` +
              `Handler-invoked loaders (ctx.use(Loader) inside a handler) cannot use rendered().`,
          );
        }

        const reqCtx = reqCtxRef ?? _getRequestContext();

        if (renderedPromise) return renderedPromise;

        if (!reqCtx) {
          throw new Error(
            `ctx.rendered() failed: request context not available.`,
          );
        }

        // awaitBeforeFlush cycle: segment resolution awaits this loader
        // (loader(Def, { ssr: false })), the barrier awaits segment
        // resolution, and rendered() awaits the barrier — waiting here can
        // never complete. Fail fast with the cause instead of hanging the
        // document render. Only document renders populate the set (the flag is
        // stamped per-isSSR), so the same loader may still use rendered() on
        // navigation renders.
        if (reqCtx._awaitBeforeFlushLoaderIds?.has(currentLoaderId)) {
          throw new Error(
            `Deadlock: loader "${currentLoaderId}" is registered with ` +
              `ssr: false, so the document render awaits it before ` +
              `the render barrier resolves — ctx.rendered() (and the ` +
              `ctx.get(handle) read it gates) can never settle here. Drop ` +
              `ssr: false on this loader or move the handle read to ` +
              `a component.`,
          );
        }

        // Bidirectional deadlock check: if a handler already started
        // awaiting this loader, calling rendered() would deadlock. This is the
        // real cycle guard (it holds for both streaming and non-streaming): the
        // handler blocks segment resolution, which blocks the barrier, which
        // blocks this loader.
        if (reqCtx._handlerLoaderDeps?.has(currentLoaderId)) {
          throw new Error(
            `Deadlock: loader "${currentLoaderId}" called ctx.rendered() but a handler ` +
              `is already awaiting this loader via ctx.use(). The handler blocks ` +
              `segment resolution, which blocks the barrier, which blocks this loader. ` +
              `Move the data dependency to a loader-to-loader pattern instead.`,
          );
        }

        // Register this loader as waiting for the barrier so that
        // setupLoaderAccess can detect deadlocks when a handler
        // tries to await the same loader via ctx.use().
        if (!reqCtx._renderBarrierWaiters) {
          reqCtx._renderBarrierWaiters = new Set();
        }
        reqCtx._renderBarrierWaiters.add(currentLoaderId);

        // Streaming trees (loading()): the barrier resolves once the segment
        // tree is resolved, but loading() handlers stream behind Suspense and
        // their handle pushes are still in flight then. Their async execution
        // IS tracked in the handle store (trackHandler -> store.track), so after
        // the barrier we seal (no further handlers register once the tree is
        // resolved) and wait for settled — every tracked handler, streaming
        // included, has finished pushing. The loader's own segment streams in
        // after, so this does not block the shell; the deadlock guard above
        // keeps a handler from depending on this loader.
        const streaming = reqCtx._treeHasStreaming === true;
        renderedPromise = reqCtx._renderBarrier.then(async () => {
          if (streaming) {
            reqCtx._handleStore.seal();
            await reqCtx._handleStore.settled;
            // The eager snapshot was intentionally left unbuilt for streaming
            // (it would have been incomplete). Build the complete one once, now
            // that the store has settled, so every ctx.use(handle) reads the
            // cached snapshot instead of rebuilding it per call.
            reqCtx._renderBarrierHandleSnapshot ??= buildHandleSnapshot(
              reqCtx._handleStore,
              reqCtx._renderBarrierSegmentOrder ?? [],
            );
          }
          renderedResolved = true;
        });
        return renderedPromise;
      },
    };

    // Meter this loader once via observePhase (loader:<id> perf metric +
    // rango.loader span); loaderFn runs inside the span callback so its KV/D1/
    // fetch spans nest under it. This is one of the observePhase loader funnels —
    // see instrument.ts for the single-metering contract.
    //
    // Run the loader body inside loader scope so request-scoped reads
    // (cookies()/headers() and non-cacheable ctx.get) are exempt from the
    // cache-purity guards: loaders always run fresh, so their reads never leak
    // into a cached segment. DSL loaders are already wrapped by fresh.ts; this
    // also covers handler-invoked loaders (ctx.use(Loader) from a handler),
    // which otherwise execute in the caller's cache scope and would wrongly
    // throw. rendered() gating uses the captured isDslLoader (above), so this
    // does not grant rendered() to handler-invoked loaders. Uses a body-only
    // scope, so isInsideLoaderScope() / barrier / deadlock gating is unchanged.
    //
    // `handlerInvoked` (!isDslLoader) rides on the scope for the CONSUMPTION-
    // LANE RULE: a handler-consumed loader's value is a BAKED copy in every
    // shared artifact (cache(), "use cache", the PPR shell), so its identity
    // reads are exempt from the shell-capture guard — same allowance the
    // cache-purity guards give it. DSL segment loaders keep their lane
    // machinery (live = masked at capture, bake = guarded). A DSL loader's
    // nested deps inherit isDslLoader=false only when the CHAIN started in a
    // handler; a chain started by the segment funnel stays DSL (the loader
    // scope ALS survives the body's awaits).
    // Shell fast path eligibility: a HANDLER-invoked loader executing during a
    // capture is handler-layer dynamism — on a handler-free (replayed) HIT it
    // would never re-run, freezing its consumption-lane value (#672's "fresh
    // per serve" slot shape). Mark the capture; the entry declines the fast
    // path and keeps the full tail. DSL loaders re-run on every HIT and never
    // set this.
    if (!isDslLoader) {
      const captureCtx = _getRequestContext();
      if (
        captureCtx?._shellCaptureRun &&
        captureCtx._shellCaptureHandleLiveness
      ) {
        captureCtx._shellCaptureHandleLiveness.handlerInvokedLoader = true;
      }
    }

    const promise = observePhase(PHASES.loader(loader.$$id), () =>
      Promise.resolve(
        runInsideLoaderBodyScope(
          () => loaderFn(loaderCtx as LoaderContext<any, TEnv>),
          loader.$$id,
          !isDslLoader,
        ),
      ).finally(() => {
        pendingLoaders.delete(loader.$$id);
      }),
    );

    // Auxiliary-lane tracking: keeps the handle store open for this body's
    // ctx.handle() pushes without joining `settled` (the handler barrier that
    // gates SSR/hydration and rendered()-readers — joining it would block the
    // document on the slowest loader and self-deadlock rendered() callers).
    // DSL loaders only: handler-invoked loaders are awaited by their handler,
    // so they complete inside the handler lane already. A nested DSL kickoff
    // mid-body registers while its parent is still tracked, so the lane can
    // never re-open after draining.
    if (isDslLoader && !silentHandles) {
      (reqCtxRef ?? _getRequestContext())?._handleStore?.trackAuxiliary(
        promise,
      );
    }

    loaderPromises.set(loader.$$id, promise);
    return promise;
  }

  return useLoader;
}

/**
 * Set up the use() method on handler context to access loaders and handles.
 *
 * For loaders: Lazily runs loaders, memoizes results per request.
 * For handles: Returns a push function bound to the current segment.
 *
 * Includes cycle detection: tracks dependency edges between loaders and
 * throws on circular dependencies to prevent deadlocks.
 */
export function setupLoaderAccess<TEnv>(
  ctx: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>,
): void {
  // Eagerly capture the request context and HandleStore at setup time
  // (before pipeline async ops). In workerd/Cloudflare, dynamic imports and
  // fetch() in the match pipeline can disrupt AsyncLocalStorage, causing
  // getRequestContext() to return undefined when handlers later call
  // ctx.use(handle). Capturing early ensures references survive ALS disruption.
  const reqCtxRef = _getRequestContext();
  const handleStoreRef = reqCtxRef?._handleStore;

  const useLoader = createLoaderExecutor(ctx, loaderPromises);

  ctx.use = ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
    if (isHandle(item)) {
      const handle = item;
      const store = handleStoreRef;
      const segmentId = (ctx as InternalHandlerContext<any, TEnv>)
        ._currentSegmentId;

      if (!segmentId) {
        throw new Error(
          `Handle "${handle.$$id}" used outside of handler context. ` +
            `Handles must be used within route/layout handlers.`,
        );
      }

      return withDefer(
        (dataOrFn: unknown | Promise<unknown> | (() => Promise<unknown>)) => {
          pushHandleValue(store, segmentId, handle.$$id, dataOrFn);
        },
      );
    }

    // Deadlock guard and handler-to-loader dependency tracking.
    // Skip when inside a DSL loader scope (resolveLoaderData also calls
    // ctx.use() but that's DSL-to-DSL, not handler-to-loader) or when
    // inside a handle push callback (push callbacks don't block segment
    // resolution so they can't cause rendered() deadlocks). The push-callback
    // check is an ALS scope so it also exempts an ASYNC callback's continuation
    // after its first await — relevant on streaming trees, where the guard
    // state now stays live until handleStore.settled.
    const loader = item as LoaderDefinition<any, any>;
    if (!isInsideLoaderScope() && !isInsidePushCallbackScope()) {
      const reqCtx = reqCtxRef ?? _getRequestContext();
      if (reqCtx) {
        // Direction 1: handler awaits loader that already called rendered()
        if (
          loaderPromises.has(loader.$$id) &&
          reqCtx._renderBarrierWaiters?.has(loader.$$id)
        ) {
          throw new Error(
            `Deadlock: handler is awaiting loader "${loader.$$id}" which called ctx.rendered(). ` +
              `The loader is waiting for segment resolution, but the handler blocks resolution. ` +
              `Move the data dependency to a loader-to-loader pattern instead.`,
          );
        }
        // Direction 2: track dep so rendered() can detect the deadlock if the
        // loader calls it later. Skip once the guard window is CLOSED — for a
        // non-streaming tree that is when the barrier resolves (rendered()
        // resolves immediately), and for a streaming tree it is when
        // handleStore.settled completes (rendered() keeps waiting until then, so
        // a loading() handler resuming after the barrier can still form a
        // cycle). Using the explicit guard-closed flag rather than
        // _renderBarrierSegmentOrder keeps tracking live across the streaming
        // settle wait. (Handle push callbacks are already excluded above via
        // isInsidePushCallbackScope(), so they cannot produce false positives
        // here.)
        if (!reqCtx._renderBarrierGuardClosed) {
          if (!reqCtx._handlerLoaderDeps) reqCtx._handlerLoaderDeps = new Set();
          reqCtx._handlerLoaderDeps.add(loader.$$id);
        }
      }
    }

    return useLoader(loader, null);
  }) as typeof ctx.use;
}

/**
 * Set up ctx.use() for pre-rendering (build-time).
 * Handles push to HandleStore; loaders throw with a clear error.
 */
export function setupBuildUse<TEnv>(ctx: HandlerContext<any, TEnv>): void {
  // Eagerly capture the HandleStore (same ALS protection as setupLoaderAccess).
  const handleStoreRef = _getRequestContext()?._handleStore;

  ctx.use = ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
    // Handle case: return a push function bound to the current segment
    if (isHandle(item)) {
      const handle = item;
      const store = handleStoreRef;
      const segmentId = (ctx as InternalHandlerContext<any, TEnv>)
        ._currentSegmentId;

      if (!segmentId) {
        throw new Error(
          `Handle "${handle.$$id}" used outside of handler context. ` +
            `Handles must be used within route/layout handlers.`,
        );
      }

      // Wrap with withDefer so ctx.use(Handle).defer(...) works on the build /
      // prerender path, matching production setupLoaderAccess. Without it a
      // prerender handler calling .defer() throws "defer is not a function".
      return withDefer(
        (dataOrFn: unknown | Promise<unknown> | (() => Promise<unknown>)) => {
          if (!store) return;

          const valueOrPromise =
            typeof dataOrFn === "function"
              ? (dataOrFn as () => Promise<unknown>)()
              : dataOrFn;

          store.push(handle.$$id, segmentId, valueOrPromise);
        },
      );
    }

    // Loader case: not available during pre-rendering
    throw new Error(
      "Loaders are not available during pre-rendering. " +
        "Use them on parent layouts with cache() for request-time data, " +
        "or use a passthrough prerender handler.",
    );
  }) as typeof ctx.use;
}

/**
 * Set up ctx.use() for proactive caching (silent mode).
 * Handles are silently ignored (no push to HandleStore).
 * Loaders work normally but with fresh memoization and cycle detection.
 *
 * This prevents duplicate handle data (breadcrumbs, meta) from being
 * pushed to the response stream during background proactive caching.
 */
export function setupLoaderAccessSilent<TEnv>(
  ctx: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>,
): void {
  const useLoader = createLoaderExecutor(ctx, loaderPromises, {
    silentHandles: true,
  });

  ctx.use = ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
    if (isHandle(item)) {
      // Silent mode - return a no-op so handle data is not pushed during caching.
      // Wrap with withDefer so ctx.use(Handle).defer(...) still resolves to a
      // callable resolver (also a no-op here), matching production's push shape
      // instead of throwing "defer is not a function".
      return withDefer((_dataOrFn: unknown) => {});
    }

    return useLoader(item as LoaderDefinition<any, any>, null);
  }) as typeof ctx.use;
}

/**
 * Conditional execution based on revalidation
 * Evaluates revalidation logic lazily, then executes appropriate callback
 *
 * @param shouldRevalidate - Async function that determines if revalidation is needed
 * @param onRevalidate - Callback executed if revalidation returns true
 * @param onSkip - Callback executed if revalidation returns false
 * @returns Result from either onRevalidate or onSkip
 */
export async function revalidate<T>(
  shouldRevalidate: () => Promise<boolean>,
  onRevalidate: () => Promise<T>,
  onSkip: () => T,
): Promise<T> {
  const needsRevalidation = await shouldRevalidate();
  return needsRevalidation ? await onRevalidate() : onSkip();
}
