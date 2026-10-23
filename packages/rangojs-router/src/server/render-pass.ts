/**
 * Derived render passes over a request past its middleware (PPR shell
 * capture, PPR HIT tail, background re-render), each `Object.create(base)`.
 * A field missing from a RENDER_PASS_FIELDS row reads the foreground
 * request's value (#684). derived-context-shape.rsc-test.tsx pins each row's
 * own keys.
 */
import type { RecordingShellStore } from "../cache/shell-snapshot.js";
import type { HandleStore } from "./handle-store.js";
import {
  bindRes,
  wireRenderBarrier,
  type RequestContext,
} from "./request-context.js";

type ShellImplicitCache = NonNullable<RequestContext["_shellImplicitCache"]>;

/** _handleStore, readonly on RequestContext, is written by the rows. */
type PassUnderConstruction = RequestContext<any> & {
  _handleStore: HandleStore;
};

/** What each purpose's caller builds for its row. */
export interface RenderPassInit {
  "shell-capture": {
    handleStore: HandleStore;
    /** A navigation-only capture renders this URL instead of the request's. */
    identity: { request: Request; url: URL } | undefined;
    /** Only with a cache store on the request. */
    recording:
      | { store: RecordingShellStore; implicitCache: ShellImplicitCache }
      | undefined;
  };
  "ppr-tail": {
    /** The request's store, shared: the tail's handles are this response's. */
    handleStore: HandleStore;
    loaderSeed: RequestContext["_shellLoaderSeed"];
    implicitCache: ShellImplicitCache;
  };
  "background-revalidation": {
    handleStore: HandleStore;
    /** Throwaway: the pass's response writes land here and are dropped. */
    sink: RequestContext<any>;
  };
}

export type RenderPurpose = keyof RenderPassInit;

interface PassFieldPolicy<I> {
  /** "own": wireRenderBarrier(pass, init.handleStore) before `own` runs. */
  readonly renderBarrier: "own" | "inherited";
  /**
   * Named stores, not one Object.assign: on Node 24 an Object.assign that
   * takes the object to 20 own properties leaves it in V8 dictionary mode
   * (#1109).
   */
  readonly own: (
    pass: PassUnderConstruction,
    init: I,
    base: RequestContext<any>,
  ) => void;
}

export const RENDER_PASS_FIELDS: {
  readonly [P in RenderPurpose]: PassFieldPolicy<RenderPassInit[P]>;
} = {
  /** rsc/shell-capture.ts deriveShellCaptureContext. */
  "shell-capture": {
    // #684: an inherited barrier is the foreground's, already resolved:
    // ctx.rendered() returns at once and ctx.use(handle) bakes the
    // foreground's handles into the shell.
    renderBarrier: "own",
    own(pass, { handleStore, identity, recording }, base) {
      // Fresh: the foreground's is drained and throws LateHandlePushError.
      pass._handleStore = handleStore;
      // The capture notes its own route records, not the foreground's.
      pass._routeRecordWindow = undefined;
      if (identity) {
        pass.request = identity.request;
        pass.url = identity.url;
        pass.originalUrl = new URL(identity.url);
        pass.pathname = identity.url.pathname;
        pass.searchParams = identity.url.searchParams;
      }
      // The shell entry's invalidation tags (loader tags belong to holes).
      pass._requestTags = new Set<string>();
      // A capture-ephemeral store in the handler-lifetime set would warn on
      // every later updateTag() and retain the snapshot.
      pass._explicitTaggedStores = new Set();
      // The capture's render errors refuse the capture only.
      pass._renderErrors = [];
      pass._recoveredHandlerErrors = undefined;
      // Read by the loader, cookies() and headers() capture guards.
      pass._shellCaptureRun = true;
      // The inherited dynamic() writes the foreground, which already served;
      // settleCaptureRecord and captureAndStoreShell read this latch.
      pass._dynamic = false;
      pass.dynamic = (): void => {
        pass._dynamic = true;
      };
      // An inherited true makes serializeSegments double-encode a fragment.
      pass._shellFragmentPayload = false;
      // Metrics and spans are foreground surfaces, already ended.
      pass._metricsStore = undefined;
      pass._tracing = undefined;
      // Bake-lane loader containers: settleCaptureRecord awaits them, the
      // drain pins them into the snapshot.
      pass._shellCaptureLoaderRecords = new Map();
      // Fired by settleCaptureRecord: the capture builds no Response, and the
      // doc record's write is gated on onResponse.
      pass._onResponseCallbacks = [];
      if (recording) {
        // Own, so the request's _cacheStore is untouched.
        pass._cacheStore = recording.store;
        // Collects deferred cache writes (settleCaptureRecord awaits them)
        // and still forwards each to the request's waitUntil.
        pass.waitUntil = (fn: () => Promise<void>): void => {
          const p = Promise.resolve().then(fn);
          recording.store.trackWrite(p);
          base.waitUntil(() => p);
        };
        // The doc record goes into the snapshot only, so a recapture misses
        // and handlers re-run.
        pass._shellImplicitCache = recording.implicitCache;
      }
    },
  },

  /** rsc/rsc-rendering.ts serveShellHit. */
  "ppr-tail": {
    // An inherited barrier carries the base's premature non-streaming handle
    // snapshot into a streaming tail.
    renderBarrier: "own",
    own(pass, { handleStore, loaderSeed, implicitCache }) {
      // #1035: the document hydrates with the handles as of the record
      // replay, before any loader runs.
      const resolveRenderBarrier = pass._resolveRenderBarrier;
      pass._resolveRenderBarrier = (segments) => {
        handleStore.freezeDocumentSnapshot();
        resolveRenderBarrier(segments);
      };
      if (loaderSeed) pass._shellLoaderSeed = loaderSeed;
      pass._shellImplicitCache = implicitCache;
      // #700 fragment splice: own, so it never reaches a capture render.
      pass._shellFragmentPayload = true;
    },
  },

  /**
   * router/match-middleware/background-revalidation.ts rerenderAndCacheRoute.
   */
  "background-revalidation": {
    // The request's barrier; whether this pass needs its own is rango-t160.
    renderBarrier: "inherited",
    own(pass, { handleStore, sink }) {
      // Read late by loader pushes and cache-scope.ts; setupLoaderAccess
      // binds it at setup, so that also runs inside this pass.
      pass._handleStore = handleStore;
      // Nothing lands on the foreground's perf timeline.
      pass._metricsStore = undefined;
      pass._renderErrors = [];
      pass._recoveredHandlerErrors = undefined;
      // Response writes go to the sink: a layout above the cache() boundary
      // or an error boundary's status would otherwise reach the live response.
      pass._onResponseCallbacks = [];
      pass.header = sink.header;
      pass.setCookie = sink.setCookie;
      pass.deleteCookie = sink.deleteCookie;
      pass.setStatus = sink.setStatus;
      pass._setStatus = sink._setStatus;
      pass.setTheme = sink.setTheme;
      pass._rotateStateCookie = sink._rotateStateCookie;
      pass._setKeepCacheDirective = sink._setKeepCacheDirective;
      bindRes(pass, () => sink.res);
    },
  },
};

/**
 * `Object.create(base)` with RENDER_PASS_FIELDS[purpose]'s own fields. The only
 * place a request context is derived (tools/check-internals.mjs).
 */
export function deriveRenderPass<P extends RenderPurpose, TEnv>(
  base: RequestContext<TEnv>,
  purpose: P,
  init: RenderPassInit[P],
): RequestContext<TEnv> {
  const policy = RENDER_PASS_FIELDS[purpose];
  const pass: RequestContext<TEnv> = Object.create(base);
  if (policy.renderBarrier === "own") {
    wireRenderBarrier(pass, init.handleStore);
  }
  policy.own(pass, init, base);
  return pass;
}
