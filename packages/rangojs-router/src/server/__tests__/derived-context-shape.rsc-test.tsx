/**
 * What each derived request context owns and what it reads from the request
 * it derives from: the PPR shell capture (rsc/shell-capture.ts
 * deriveShellCaptureContext), the PPR HIT tail (rsc/rsc-rendering.ts
 * createTailContext and the seeding after it), the background re-render of a
 * stale route record (router/match-middleware/background-revalidation.ts
 * rerenderAndCacheRoute), the re-run of a stale document cache entry
 * (cache/document-cache.ts), and what rebaseRequestContext moves when
 * middleware rewrites a request. A field missing from a derivation's own set
 * reads the foreground request's value through the prototype (#684: a
 * capture that inherited the foreground's render barrier baked foreground
 * handle data into the shared shell).
 *
 * Building these derivations from one table of fields must reproduce each
 * own-key set here, the background pass inheriting the render barrier
 * included.
 *
 * An rsc-test: the tail exists only inside a shell HIT, so it is observed
 * through serveShellRequest, at the start of the tail's match (the router's
 * request.start telemetry event), before matching writes anything to it.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);

import {
  createRequestContext,
  rebaseRequestContext,
  runWithRequestContext,
  _getRequestContext,
  type RequestContext,
} from "../request-context.js";
import { createHandleStore, type HandleStore } from "../handle-store.js";
import { getContext } from "../context.js";
import { deriveShellCaptureContext } from "../../rsc/shell-capture.js";
import { rerenderAndCacheRoute } from "../../router/match-middleware/background-revalidation.js";
import type { MatchContext } from "../../router/match-context.js";
import type { RouterContext } from "../../router/router-context.js";
import type { CacheScope } from "../../cache/cache-scope.js";
import {
  createDocumentCacheMiddleware,
  MemorySegmentCacheStore,
} from "../../cache/index.js";
import type { MiddlewareContext } from "../../router/middleware.js";
import { resolveThemeConfig } from "../../theme/constants.js";
import {
  resetShellTestState,
  serveShellRequest,
} from "../../testing/flight.entry.js";
import { createLoader, createRouter, urls } from "../../index.rsc.js";

/**
 * Own property keys, sorted: a symbol by its description in brackets, an
 * accessor and a non-enumerable property marked.
 */
function ownKeys(object: object): string[] {
  return Reflect.ownKeys(object)
    .map((key) => {
      const d = Object.getOwnPropertyDescriptor(object, key)!;
      const name = typeof key === "symbol" ? `[${key.description}]` : key;
      return `${name}${d.get || d.set ? " (accessor)" : ""}${d.enumerable ? "" : " (hidden)"}`;
    })
    .sort();
}

function requestContext(
  href = "https://example.com/p",
  withStore = true,
): RequestContext {
  const request = new Request(href);
  return createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
    cacheStore: withStore ? new MemorySegmentCacheStore() : undefined,
    // ctx.setTheme exists only with a theme config.
    themeConfig: resolveThemeConfig(true),
    // The state and fresh-reads cookie writers write only with a name.
    stateCookieName: "rango-state",
  });
}

/** The render barrier family wireRenderBarrier resets as own properties. */
const RENDER_BARRIER = [
  "[rango.requestContext.renderBarrier] (hidden)",
  "_awaitBeforeFlushLoaderIds",
  "_handlerLoaderDeps",
  "_renderBarrier (accessor) (hidden)",
  "_renderBarrierGuardClosed",
  "_renderBarrierHandleSnapshot",
  "_renderBarrierSegmentOrder",
  "_renderBarrierWaiters",
  "_resolveRenderBarrier",
  "_treeHasStreaming",
];

describe("shell capture context (deriveShellCaptureContext)", () => {
  const CAPTURE_OWN = [
    ...RENDER_BARRIER,
    "_dynamic",
    "_explicitTaggedStores",
    "_handleStore",
    "_metricsStore",
    "_onResponseCallbacks",
    "_recoveredHandlerErrors",
    "_renderErrors",
    "_requestTags",
    "_shellCaptureState",
    "_shellFragmentPayload",
    "_tracing",
    "dynamic",
  ];
  /** RENDER_PASS_FIELDS["shell-capture"] creates every field. */
  const SHELL_CAPTURE_STATE = [
    "forVisitor",
    "guardTripped",
    "guardTrippedLoaderId",
    "loaderLanes",
    "loaderRecords",
    "routeRecordWindow",
    "run",
    "unrecordedLoaderPush",
  ];
  /** Only with a cache store on the request: the recording store and its scope. */
  const WITH_STORE = ["_cacheStore", "_shellImplicitCache", "waitUntil"];
  /** Only for a navigation-only capture, which renders another URL. */
  const IDENTITY = [
    "originalUrl",
    "pathname",
    "request",
    "searchParams",
    "url",
  ];

  it("owns its render barrier, handle store, error and tag lists, and the recording store; reads the rest from the request", () => {
    const base = requestContext();
    const baseStore = base._cacheStore;
    const { derivedCtx: capture, freshHandleStore } = deriveShellCaptureContext(
      base,
      { ttl: 60, swr: 300 },
    );

    expect(Object.getPrototypeOf(capture)).toBe(base);
    expect(ownKeys(capture)).toEqual([...CAPTURE_OWN, ...WITH_STORE].sort());

    // Fresh: none of these is the request's.
    expect(capture._handleStore).toBe(freshHandleStore);
    expect(capture._handleStore).not.toBe(base._handleStore);
    expect(capture._resolveRenderBarrier).not.toBe(base._resolveRenderBarrier);
    expect(capture._requestTags).not.toBe(base._requestTags);
    expect(capture._requestTags.size).toBe(0);
    expect(capture._explicitTaggedStores).not.toBe(base._explicitTaggedStores);
    expect(capture._renderErrors).toEqual([]);
    expect(capture._renderErrors).not.toBe(base._renderErrors);
    expect(capture._onResponseCallbacks).toEqual([]);
    expect(capture._onResponseCallbacks).not.toBe(base._onResponseCallbacks);
    expect(capture._shellCaptureState?.loaderRecords).toEqual(new Map());
    expect(capture._cacheStore).not.toBe(baseStore);
    expect(capture.waitUntil).not.toBe(base.waitUntil);
    expect(capture._shellImplicitCache).toMatchObject({
      ttl: 60,
      swr: 300,
      keyPrefix: "doc",
    });
    expect(ownKeys(capture._shellCaptureState!)).toEqual(SHELL_CAPTURE_STATE);
    expect({
      "_shellCaptureState.run": capture._shellCaptureState?.run,
      _dynamic: capture._dynamic,
      _shellFragmentPayload: capture._shellFragmentPayload,
      _metricsStore: capture._metricsStore,
      _tracing: capture._tracing,
      "_shellCaptureState.routeRecordWindow":
        capture._shellCaptureState?.routeRecordWindow,
      _recoveredHandlerErrors: capture._recoveredHandlerErrors,
    }).toEqual({
      "_shellCaptureState.run": true,
      _dynamic: false,
      _shellFragmentPayload: false,
      _metricsStore: undefined,
      _tracing: undefined,
      "_shellCaptureState.routeRecordWindow": undefined,
      _recoveredHandlerErrors: undefined,
    });
    // Its dynamic() opts out the capture, not the request.
    capture.dynamic();
    expect(capture._dynamic).toBe(true);
    expect(base._dynamic).toBe(false);

    // Inherited: the request's identity, variables, response and the record
    // keys it resolved, which the derivation creates on the request.
    expect(capture.request).toBe(base.request);
    expect(capture.url).toBe(base.url);
    expect(capture._variables).toBe(base._variables);
    expect(capture.res).toBe(base.res);
    expect(base._resolvedCacheKeys).toBeInstanceOf(Map);
    expect(capture._resolvedCacheKeys).toBe(base._resolvedCacheKeys);
  });

  it("starts from its own reset values when the request has already rendered (#684)", async () => {
    const base = requestContext();
    const onError = (): void => {};
    base._handleStore.onError = onError;
    // The request's barrier resolved, and the request rendered, reported and
    // tagged before the capture is derived.
    base._resolveRenderBarrier([]);
    await base._renderBarrier;
    Object.assign(base, {
      _metricsStore: { metrics: [] },
      _tracing: { tracer: {} },
      _shellCaptureState: { routeRecordWindow: { reads: [] } },
      _recoveredHandlerErrors: new Map([["M0", new Error("recovered")]]),
      _shellFragmentPayload: true,
      _dynamic: true,
      _treeHasStreaming: true,
      _renderBarrierSegmentOrder: ["x"],
      _renderBarrierHandleSnapshot: {},
      _renderBarrierGuardClosed: true,
      _renderBarrierWaiters: new Set(["w"]),
      _handlerLoaderDeps: new Set(["d"]),
      _awaitBeforeFlushLoaderIds: new Set(["a"]),
      _renderErrors: [new Error("rendered")],
    });
    base._onResponseCallbacks.push((response) => response);
    base._requestTags.add("t");
    base._explicitTaggedStores = new Set([base._cacheStore!]);

    const { derivedCtx: capture } = deriveShellCaptureContext(base, {
      ttl: 60,
      swr: 300,
    });

    expect({
      _metricsStore: capture._metricsStore,
      _tracing: capture._tracing,
      "_shellCaptureState.routeRecordWindow":
        capture._shellCaptureState?.routeRecordWindow,
      _recoveredHandlerErrors: capture._recoveredHandlerErrors,
      _shellFragmentPayload: capture._shellFragmentPayload,
      _dynamic: capture._dynamic,
      _treeHasStreaming: capture._treeHasStreaming,
      _renderBarrierSegmentOrder: capture._renderBarrierSegmentOrder,
      _renderBarrierHandleSnapshot: capture._renderBarrierHandleSnapshot,
      _renderBarrierGuardClosed: capture._renderBarrierGuardClosed,
      _renderBarrierWaiters: capture._renderBarrierWaiters,
      _handlerLoaderDeps: capture._handlerLoaderDeps,
      _awaitBeforeFlushLoaderIds: capture._awaitBeforeFlushLoaderIds,
      _renderErrors: capture._renderErrors,
      _onResponseCallbacks: capture._onResponseCallbacks,
      _requestTags: capture._requestTags,
      _explicitTaggedStores: capture._explicitTaggedStores,
    }).toEqual({
      _metricsStore: undefined,
      _tracing: undefined,
      "_shellCaptureState.routeRecordWindow": undefined,
      _recoveredHandlerErrors: undefined,
      _shellFragmentPayload: false,
      _dynamic: false,
      _treeHasStreaming: undefined,
      _renderBarrierSegmentOrder: undefined,
      _renderBarrierHandleSnapshot: undefined,
      _renderBarrierGuardClosed: undefined,
      _renderBarrierWaiters: undefined,
      _handlerLoaderDeps: undefined,
      _awaitBeforeFlushLoaderIds: undefined,
      _renderErrors: [],
      _onResponseCallbacks: [],
      _requestTags: new Set(),
      _explicitTaggedStores: new Set(),
    });
    // Its barrier is pending until the capture's own tree resolves it.
    const pending = Symbol("pending");
    expect(
      await Promise.race([capture._renderBarrier, Promise.resolve(pending)]),
    ).toBe(pending);
    // The handle store is new; its error reporting is the request's.
    expect(capture._handleStore).not.toBe(base._handleStore);
    expect(capture._handleStore.onError).toBe(onError);
  });

  it("a navigation-only capture also owns the URL it renders", () => {
    const base = requestContext();
    const request = new Request("https://example.com/other?x=1");
    const url = new URL(request.url);
    const { derivedCtx: capture } = deriveShellCaptureContext(
      base,
      { ttl: 60, swr: 300 },
      { request, url },
    );

    expect(ownKeys(capture)).toEqual(
      [...CAPTURE_OWN, ...WITH_STORE, ...IDENTITY].sort(),
    );
    expect(capture.request).toBe(request);
    expect(capture.url).toBe(url);
    expect(capture.originalUrl).not.toBe(url);
    expect(capture.originalUrl.href).toBe(url.href);
    expect(capture.pathname).toBe("/other");
    expect(capture.searchParams).toBe(url.searchParams);
  });

  it("without a cache store on the request it records nothing", () => {
    const base = requestContext("https://example.com/p", false);
    const { derivedCtx: capture } = deriveShellCaptureContext(base, {
      ttl: 60,
      swr: 300,
    });

    expect(ownKeys(capture)).toEqual([...CAPTURE_OWN].sort());
  });
});

describe("PPR HIT tail context (createTailContext)", () => {
  it("owns its render barrier and the replay seeding; shares the request's handle store", async () => {
    await resetShellTestState();
    const tails: { ctx: RequestContext; ownKeys: string[] }[] = [];
    const bases: RequestContext[] = [];
    const BakedLoader = createLoader(async () => ({ baked: "baked" }));
    const LiveLoader = createLoader(async () => ({ live: "live" }));
    const router = createRouter({
      telemetry: {
        emit(event) {
          if (event.type !== "request.start") return;
          const ctx = _getRequestContext();
          if (ctx?._shellImplicitCache?.docTail) {
            tails.push({ ctx, ownKeys: ownKeys(ctx) });
          }
        },
      },
    })
      .use(async (_ctx, next) => {
        bases.push(_getRequestContext()!);
        await next();
      })
      .routes(
        urls(({ path, loader, loading }) => [
          path(
            "/ppr",
            () => <p>page</p>,
            { name: "ppr", ppr: true },
            () => [
              loader(BakedLoader, { ssr: false }),
              loader(LiveLoader),
              loading(<i>loading</i>),
            ],
          ),
        ]),
      );
    const cacheStore = new MemorySegmentCacheStore();

    expect(
      (await serveShellRequest(router, "/ppr", { cacheStore })).shellStatus,
    ).toBe("MISS");
    bases.length = 0;
    expect(
      (await serveShellRequest(router, "/ppr", { cacheStore })).shellStatus,
    ).toBe("HIT");

    expect(tails).toHaveLength(1);
    const [{ ctx: tail, ownKeys: atStart }] = tails as [(typeof tails)[0]];
    expect(bases).toHaveLength(1);
    const base = bases[0]!;
    expect(Object.getPrototypeOf(tail)).toBe(base);
    expect(atStart).toEqual(
      [
        ...RENDER_BARRIER,
        "_shellFragmentPayload",
        "_shellImplicitCache",
        "_shellLoaderSeed",
      ].sort(),
    );
    // Its barrier closes over the tail, its handle store is the request's.
    expect(tail._resolveRenderBarrier).not.toBe(base._resolveRenderBarrier);
    expect(Object.hasOwn(tail, "_handleStore")).toBe(false);
    expect(tail._handleStore).toBe(base._handleStore);
    expect(tail._shellImplicitCache).toMatchObject({
      keyPrefix: "doc",
      docTail: true,
    });
    expect(tail._shellFragmentPayload).toBe(true);
    expect(tail._shellLoaderSeed).toBeInstanceOf(Map);
  });
});

describe("background re-render context (rerenderAndCacheRoute)", () => {
  it("owns its handle store, error lists, response writers, dynamic() and an empty capture state; inherits the request's render barrier", async () => {
    const base = requestContext();
    // The foreground has rendered: it measured, recovered and reported.
    Object.assign(base, {
      _metricsStore: { metrics: [] },
      _recoveredHandlerErrors: new Map([["M0", new Error("recovered")]]),
      _renderErrors: [new Error("rendered")],
      // Its barrier resolved: the deadlock bookkeeping is closed.
      _renderBarrierGuardClosed: true,
      _handlerLoaderDeps: new Set(["visitor-dep"]),
      _renderBarrierWaiters: new Set(["visitor-waiter"]),
    });
    base._onResponseCallbacks.push((response) => response);
    const handleStore = createHandleStore();
    let renderCtx: RequestContext | undefined;
    let ownAtStart: string[] = [];
    const routerCtx = {
      createHandleStore: (): HandleStore => handleStore,
      createHandlerContext: () => {
        renderCtx = _getRequestContext();
        ownAtStart = ownKeys(renderCtx!);
        return {};
      },
      setupLoaderAccess: () => {},
      resolveAllSegments: async () => ({
        segments: [],
        matchedIds: [],
      }),
    } as unknown as RouterContext;
    const match = {
      env: {},
      request: base.request,
      url: base.url,
      pathname: "/p",
      matched: { params: {}, routeKey: "r" },
      routeMap: {},
      entries: [],
      routeKey: "r",
      Store: getContext().getOrCreateStore("r"),
      interceptResult: null,
      isIntercept: false,
    } as unknown as MatchContext;
    const cacheScope = {
      cacheRoute: async () => {},
    } as unknown as CacheScope;

    await rerenderAndCacheRoute(match, base, cacheScope, routerCtx);

    const ctx = renderCtx!;
    expect(Object.getPrototypeOf(ctx)).toBe(base);
    expect(ownAtStart).toEqual([
      "[rango.requestContext.res] (hidden)",
      "_handleStore",
      "_handlerLoaderDeps",
      "_metricsStore",
      "_onResponseCallbacks",
      "_recoveredHandlerErrors",
      "_renderBarrierGuardClosed",
      "_renderBarrierWaiters",
      "_renderErrors",
      "_rotateStateCookie",
      "_setFreshReadsCookie",
      "_setKeepCacheDirective",
      "_setStatus",
      "_shellCaptureState",
      "deleteCookie",
      "dynamic",
      "header",
      "res (accessor)",
      "setCookie",
      "setStatus",
      "setTheme",
    ]);
    expect(ctx._handleStore).toBe(handleStore);
    expect(ctx._shellCaptureState).toBeUndefined();
    expect({
      _metricsStore: ctx._metricsStore,
      _recoveredHandlerErrors: ctx._recoveredHandlerErrors,
      _renderErrors: ctx._renderErrors,
      _onResponseCallbacks: ctx._onResponseCallbacks,
    }).toEqual({
      _metricsStore: undefined,
      _recoveredHandlerErrors: undefined,
      _renderErrors: [],
      _onResponseCallbacks: [],
    });
    // Response writes and dynamic() land on a throwaway context: no writer
    // is the request's.
    const writers = [
      "dynamic",
      "header",
      "setCookie",
      "deleteCookie",
      "setStatus",
      "_setStatus",
      "setTheme",
      "_rotateStateCookie",
      "_setKeepCacheDirective",
      "_setFreshReadsCookie",
    ] as const;
    expect(writers.filter((writer) => ctx[writer] === base[writer])).toEqual(
      [],
    );
    expect(ctx.res).not.toBe(base.res);
    ctx.setStatus(500);
    ctx.header("x-background", "1");
    ctx.setCookie("background", "1");
    ctx.deleteCookie("session");
    ctx._rotateStateCookie();
    ctx._setFreshReadsCookie(5_000);
    ctx.dynamic();
    expect(base._dynamic).toBe(false);
    expect(base.res.status).toBe(200);
    expect(base.res.headers.get("x-background")).toBeNull();
    expect(base.res.headers.get("set-cookie")).toBeNull();
    // No barrier of its own: the request's resolved before the pass starts,
    // so an open intercept's loader passes rendered() at once, and the
    // record keeps nothing it reads.
    expect(Object.hasOwn(ctx, "_resolveRenderBarrier")).toBe(false);
    expect(ctx._resolveRenderBarrier).toBe(base._resolveRenderBarrier);
    // Its deadlock bookkeeping is open, so a handler awaiting a loader that
    // calls rendered() is refused as on a MISS, not let through.
    expect({
      _renderBarrierGuardClosed: ctx._renderBarrierGuardClosed,
      _handlerLoaderDeps: ctx._handlerLoaderDeps,
      _renderBarrierWaiters: ctx._renderBarrierWaiters,
    }).toEqual({
      _renderBarrierGuardClosed: undefined,
      _handlerLoaderDeps: undefined,
      _renderBarrierWaiters: undefined,
    });
  });
});

describe("document cache re-run context (document-cache.ts)", () => {
  it("owns its render barrier, use(), dynamic() latch, error lists and response writers over the request's handle store", async () => {
    const base = requestContext();
    base.header("x-before", "1");
    base._cacheStore = {
      getResponse: async () => ({
        response: new Response("stale"),
        shouldRevalidate: true,
      }),
      putResponse: async () => {},
    } as unknown as RequestContext["_cacheStore"];
    const tasks: Promise<void>[] = [];
    base.waitUntil = (fn) => {
      tasks.push(Promise.resolve().then(fn));
    };
    let rerun: RequestContext | undefined;
    let ownAtStart: string[] = [];
    const next = async (): Promise<Response> => {
      rerun = _getRequestContext();
      ownAtStart = ownKeys(rerun!);
      return new Response("fresh", {
        headers: { "Cache-Control": "s-maxage=60" },
      });
    };
    const stale = await runWithRequestContext(base, () =>
      createDocumentCacheMiddleware()(
        {
          request: base.request,
          url: base.url,
          env: {},
        } as unknown as MiddlewareContext,
        next,
      ),
    );
    expect(stale.headers.get("x-document-cache-status")).toBe("STALE");
    // After the stale hit: the visitor's own write, not the re-run's.
    base.header("x-after", "1");
    await Promise.all(tasks);

    const ctx = rerun!;
    expect(Object.getPrototypeOf(ctx)).toBe(base);
    expect(ownAtStart).toEqual(
      [
        ...RENDER_BARRIER,
        "[rango.requestContext.res] (hidden)",
        "_dynamic",
        "_handleStore",
        "_handlerTiming",
        "_metricsStore",
        "_onResponseCallbacks",
        "_recoveredHandlerErrors",
        "_renderErrors",
        "_rotateStateCookie",
        "_setFreshReadsCookie",
        "_setKeepCacheDirective",
        "_setStatus",
        "_shellCaptureState",
        "deleteCookie",
        "dynamic",
        "header",
        "res (accessor)",
        "setCookie",
        "setStatus",
        "setTheme",
        "use",
      ].sort(),
    );
    // The request's handle store, its own barrier over it and its own use().
    expect(ctx._handleStore).toBe(base._handleStore);
    expect(ctx._resolveRenderBarrier).not.toBe(base._resolveRenderBarrier);
    expect(ctx.use).not.toBe(base.use);
    expect({
      _metricsStore: ctx._metricsStore,
      _handlerTiming: ctx._handlerTiming,
      _recoveredHandlerErrors: ctx._recoveredHandlerErrors,
      _renderErrors: ctx._renderErrors,
      _onResponseCallbacks: ctx._onResponseCallbacks,
      _shellCaptureState: ctx._shellCaptureState,
    }).toEqual({
      _metricsStore: undefined,
      _handlerTiming: [],
      _recoveredHandlerErrors: undefined,
      _renderErrors: [],
      _onResponseCallbacks: [],
      _shellCaptureState: undefined,
    });
    // Its response starts from the request's stub at the stale hit.
    expect(ctx.res).not.toBe(base.res);
    expect(ctx.res.headers.get("x-before")).toBe("1");
    expect(ctx.res.headers.get("x-after")).toBeNull();
    const writers = [
      "dynamic",
      "header",
      "setCookie",
      "deleteCookie",
      "setStatus",
      "_setStatus",
      "setTheme",
      "_rotateStateCookie",
      "_setKeepCacheDirective",
      "_setFreshReadsCookie",
    ] as const;
    expect(writers.filter((writer) => ctx[writer] === base[writer])).toEqual(
      [],
    );
    ctx.setStatus(500);
    ctx.header("x-rerun", "1");
    ctx.setCookie("rerun", "1");
    ctx._rotateStateCookie();
    ctx._setFreshReadsCookie(5_000);
    expect(ctx.res.headers.get("x-rerun")).toBe("1");
    expect(base.res.status).toBe(200);
    expect(base.res.headers.get("x-rerun")).toBeNull();
    expect(base.res.headers.get("set-cookie")).toBeNull();
    // Its dynamic() opts out the re-run's render, not the request's.
    expect(ctx._dynamic).toBe(false);
    ctx.dynamic();
    expect(ctx._dynamic).toBe(true);
    expect(base._dynamic).toBe(false);
  });
});

describe("rewrite rebase (rebaseRequestContext)", () => {
  it("moves the request and URL fields to the target and clears the match state; keeps the rest", () => {
    const ctx = requestContext("https://example.com/visitor");
    const before = new Map(
      Reflect.ownKeys(ctx).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(ctx, key)!,
      ]),
    );
    const handleStore = ctx._handleStore;
    const variables = ctx._variables;
    const res = ctx.res;

    const target = new Request("https://example.com/target?_rsc_fill=1&q=2");
    rebaseRequestContext(ctx, target, new URL(target.url));

    const written = Reflect.ownKeys(ctx)
      .filter((key) => {
        const was = before.get(key);
        const now = Object.getOwnPropertyDescriptor(ctx, key)!;
        return !was || was.value !== now.value || was.get !== now.get;
      })
      .map(String)
      .sort();
    expect(written).toEqual([
      "_classifiedRoute",
      "_documentCacheRender",
      "_requestKind",
      "_requestMode",
      "_routeName",
      "originalUrl",
      "params",
      "pathname",
      "request",
      "reverse",
      "routeName",
      "searchParams",
      "url",
      "use",
    ]);
    expect(ctx.url.href).toBe("https://example.com/target?q=2");
    expect(ctx.originalUrl.href).toBe(target.url);
    expect(ctx.pathname).toBe("/target");
    expect(ctx._requestKind).toBe("fill");
    expect(ctx.params).toEqual({});
    expect(ctx.routeName).toBeUndefined();
    expect(ctx._handleStore).toBe(handleStore);
    expect(ctx._variables).toBe(variables);
    expect(ctx.res).toBe(res);
  });
});
