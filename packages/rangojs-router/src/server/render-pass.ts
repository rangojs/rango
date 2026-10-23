/**
 * Derived render passes: a second render over a request that has already
 * passed its middleware. A PPR shell capture, a PPR HIT tail and a background
 * re-render of a stale route record each run on `Object.create(base)`, so
 * every field the pass does not own reads the request's value through the
 * prototype (variables, env, request identity, cache store, waitUntil).
 *
 * RENDER_PASS_FIELDS is the one table of what each pass owns. A field missing
 * from a row reads the foreground request's value (#684, the shell-capture
 * row). derived-context-shape.rsc-test.tsx pins each row's own-key set.
 */
import type { RecordingShellStore } from "../cache/shell-snapshot.js";
import type { HandleStore } from "./handle-store.js";
import {
  bindRes,
  wireRenderBarrier,
  type RequestContext,
} from "./request-context.js";

type ShellImplicitCache = NonNullable<RequestContext["_shellImplicitCache"]>;

/** The pass while its row writes it: _handleStore, readonly elsewhere, is set here. */
type PassUnderConstruction = RequestContext<any> & {
  _handleStore: HandleStore;
};

/** What each purpose's caller builds and the pass's own fields read. */
export interface RenderPassInit {
  "shell-capture": {
    /** The capture's handle store, its push funnel wired (deriveShellCaptureContext). */
    handleStore: HandleStore;
    /** A navigation-only capture renders this URL instead of the request's. */
    identity: { request: Request; url: URL } | undefined;
    /**
     * Only with a cache store on the request: the recording wrapper over it
     * and the capture's implicit doc scope over the recording.
     */
    recording:
      | { store: RecordingShellStore; implicitCache: ShellImplicitCache }
      | undefined;
  };
  "ppr-tail": {
    /** The request's handle store: the tail renders into it. */
    handleStore: HandleStore;
    /** The entry's bake-lane loader pins, when it has records. */
    loaderSeed: RequestContext["_shellLoaderSeed"];
    /** The doc record replay over the entry's snapshot (docTail). */
    implicitCache: ShellImplicitCache;
  };
  "background-revalidation": {
    handleStore: HandleStore;
    /** A throwaway context nothing merges or drains: the pass's response writes land on it. */
    sink: RequestContext<any>;
  };
}

export type RenderPurpose = keyof RenderPassInit;

interface PassFieldPolicy<I> {
  /**
   * "own": a fresh barrier family wired to `init.handleStore` and
   * closure-bound to the pass (wireRenderBarrier), before `own` runs.
   * "inherited": the base's, read through the prototype.
   */
  readonly renderBarrier: "own" | "inherited";
  /**
   * Writes the pass's own fields. Named stores, not Object.assign of one
   * literal: on Node 24 an Object.assign of 20 properties leaves the object
   * in V8 dictionary mode (#1109), and the capture owns over 30.
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
  /**
   * rsc/shell-capture.ts deriveShellCaptureContext. The capture inherits the
   * foreground's post-middleware state and owns the render-scoped
   * accumulators: its match() behaves like a normal render (cache()'d
   * segments replay, uncached handlers run fresh) while the foreground's
   * response is already sent.
   */
  "shell-capture": {
    // Own render barrier, closure-bound to the derived ctx and the fresh store
    // (issue #684, plan 009). Without this every _renderBarrier* read fell
    // through the prototype to the foreground's ALREADY-RESOLVED barrier: a
    // bake-lane loader's `await ctx.rendered()` resolved instantly and
    // ctx.use(handle) read the FOREGROUND handle snapshot — foreground
    // per-request handle data could bake into the shared shell.
    // wireRenderBarrier also resets _treeHasStreaming (recomputed for the
    // capture's tree) and the deadlock-guard fields as own properties.
    renderBarrier: "own",
    own(pass, { handleStore, identity, recording }, base) {
      // A fresh store. The foreground store is already drained to completion
      // (its stream() flipped `completed` on settle) and would throw
      // LateHandlePushError on any re-push. Every downstream reader resolves
      // the store off the ambient context (setupLoaderAccess captures
      // _getRequestContext()._handleStore; trackHandler reads it), so the
      // fresh store on the derived context is what the capture match()
      // writes handles to.
      pass._handleStore = handleStore;
      // The capture notes the route records it reads or writes itself; the
      // foreground's (a partial request's `partial:` record, say) are not the
      // ones this shell is captured from.
      pass._routeRecordWindow = undefined;
      // A navigation-only capture renders another URL than its request's.
      if (identity) {
        pass.request = identity.request;
        pass.url = identity.url;
        pass.originalUrl = new URL(identity.url);
        pass.pathname = identity.url.pathname;
        pass.searchParams = identity.url.searchParams;
      }
      // The capture collects its OWN shell tags here — non-loader tags only,
      // since loaders are masked — which is exactly the tag set a shell entry
      // should be invalidatable by (loader tags belong to holes).
      pass._requestTags = new Set<string>();
      // Own explicit-store registry: cache-store resolutions during the
      // capture (the implicit scope's SnapshotOnlySegmentStore, any
      // per-capture explicit store instance) must NOT register into the
      // handler-lifetime _explicitTaggedStores set — a capture-ephemeral
      // store pinned there would trip the partial-tag-store warning on every
      // later updateTag() and retain the whole capture snapshot in memory.
      // Capture registrations die with this context; module-singleton stores
      // stay registered by normal renders.
      pass._explicitTaggedStores = new Set();
      // Own lists: the capture's render errors refuse the capture only, and
      // the foreground's never reach it.
      pass._renderErrors = [];
      pass._recoveredHandlerErrors = undefined;
      // The switch the loader, cookies() and headers() capture guards read.
      pass._shellCaptureRun = true;
      // Own dynamic() latch. The inherited method writes the FOREGROUND
      // context (its closure), which already served, and nothing read it for
      // a runtime capture: handler code that opts out after an await (a
      // handler promise the capture now waits for) must refuse THIS capture
      // instead (settleCaptureRecord and captureAndStoreShell read _dynamic).
      // The ppr header latch is left alone: a capture's response is never
      // sent.
      pass._dynamic = false;
      pass.dynamic = (): void => {
        pass._dynamic = true;
      };
      // Own-property reset: an inherited flag would make serializeSegments
      // store a double-encoded fragment. No current arming site reaches a
      // capture render (kept as defense-in-depth for a future one).
      pass._shellFragmentPayload = false;
      // The capture never appends to the foreground's (already-finalized)
      // metrics.
      pass._metricsStore = undefined;
      // Spans, like perf metrics above, are a FOREGROUND surface: the capture
      // re-render must not emit a second rango.render/loader/ssr set after
      // the foreground rango.request span ended (orphan spans in the trace).
      pass._tracing = undefined;
      // Bake-lane (`ssr: false`) loader containers, which execute during
      // capture (docs/design/loader-container-bake.md). resolveLoaderData
      // registers each container promise here; settleCaptureRecord waits for
      // them, and the drain in captureAndStoreShell elides + pins them into
      // the snapshot's loader family.
      pass._shellCaptureLoaderRecords = new Map();
      // Own onResponse list so the capture's match-middleware callbacks (the
      // doc record registers here) are ISOLATED from the foreground's shared
      // array AND can be fired by settleCaptureRecord. The segment write is
      // gated behind onResponse, which the capture never triggers (it builds
      // no Response): without the synthetic fire, no doc record is written.
      pass._onResponseCallbacks = [];
      // Capture data snapshot: the capture's cache-store calls go through a
      // recording wrapper on the DERIVED context's store (own property, so
      // the request's _cacheStore is untouched — the snapshot is
      // per-capture). It records the doc segment record, which rides inside
      // the ShellCacheEntry with the bake-lane loader pins; no cache read is
      // recorded. See cache/shell-snapshot.ts and the design doc.
      if (recording) {
        pass._cacheStore = recording.store;
        // Cache writes are deferred (waitUntil): the doc record's write would
        // otherwise land after the match returns. The own waitUntil COLLECTS
        // those write promises (still forwarding to the request's so the
        // write persists and the worker stays alive), then
        // settleCaptureRecord and captureAndStoreShell await them before
        // reading the record and draining.
        pass.waitUntil = (fn: () => Promise<void>): void => {
          const p = Promise.resolve().then(fn);
          recording.store.trackWrite(p);
          base.waitUntil(() => p);
        };
        // The doc record (capture side): the implicit doc-cache scope makes
        // the capture's match write ALL matched non-loader segments as one
        // doc-keyed segment record — into the snapshot only
        // (SnapshotOnlySegmentStore), so the record dies with the shell entry
        // and the next capture's lookup still misses (handlers re-run on
        // recapture). A route deriving its own cache() scope keeps it, and
        // recordShellCaptureDocRecord (cache-store.ts) writes the same record
        // for it.
        pass._shellImplicitCache = recording.implicitCache;
      }
    },
  },

  /**
   * rsc/rsc-rendering.ts serveShellHit: the live tail behind a committed
   * shell prelude. It replays the entry's doc record and serves its loader
   * pins, and shares the request's handle store (not an own field): the
   * tail's handles are this response's.
   */
  "ppr-tail": {
    // Matching writes render state onto the derived context. Its barrier must
    // close over that same context or a streaming tail inherits the base
    // context's premature non-streaming handle snapshot.
    renderBarrier: "own",
    own(pass, { handleStore, loaderSeed, implicitCache }) {
      // The tail's render barrier resolves once its record is replayed and
      // before a loader runs (cache-lookup.ts withCacheLookup,
      // yieldFromStore). The store then holds what the prelude was rendered
      // from, so that is the snapshot the document hydrates with; what this
      // request's loaders do to it afterwards reaches the client after
      // hydration (HandleStore.freezeDocumentSnapshot, issue #1035).
      const resolveRenderBarrier = pass._resolveRenderBarrier;
      pass._resolveRenderBarrier = (segments) => {
        handleStore.freezeDocumentSnapshot();
        resolveRenderBarrier(segments);
      };
      if (loaderSeed) pass._shellLoaderSeed = loaderSeed;
      pass._shellImplicitCache = implicitCache;
      // Fragment splice (issue #700): store hits in THIS tail emit their
      // stored segment fragments verbatim (expanded by segment-fragments.ts).
      // The flag lives on the derived context so it can never leak into a
      // capture render, which serializes segments and must see real
      // elements.
      pass._shellFragmentPayload = true;
    },
  },

  /**
   * router/match-middleware/background-revalidation.ts rerenderAndCacheRoute:
   * a stale HIT's refresh and proactive caching. It owns the per-render
   * state the foreground reads while it is still producing the page (a stale
   * HIT re-runs its loaders; a proactive render starts once the Response
   * exists, while its body streams).
   */
  "background-revalidation": {
    // The request's barrier, read through the prototype: unlike the two rows
    // above, this pass wires none of its own. Whether it should is the open
    // question rango-t135-q1.
    renderBarrier: "inherited",
    own(pass, { handleStore, sink }) {
      // Read late (loader pushes and aux-lane tracking in
      // loader-resolution.ts, nested cache restores and captures in
      // cache-scope.ts), so a swap sent live pushes into this render.
      // setupLoaderAccess binds the store at setup, so it runs inside the
      // derived context too.
      pass._handleStore = handleStore;
      // Nothing lands on the foreground's perf timeline (the DSL store's
      // `metrics` is unset too, rerenderAndCacheRoute).
      pass._metricsStore = undefined;
      pass._renderErrors = [];
      pass._recoveredHandlerErrors = undefined;
      // Response writes (headers, cookies, status, onResponse callbacks) go
      // to the throwaway sink (whose status gates the write) and are dropped:
      // a layout above the cache() boundary is outside the header guard and
      // an error boundary sets a status, so they would otherwise reach the
      // live response. The sink's mutators are closures over its own stub,
      // and they keep the same guards.
      pass._onResponseCallbacks = [];
      pass.header = sink.header;
      pass.setCookie = sink.setCookie;
      pass.deleteCookie = sink.deleteCookie;
      pass.setStatus = sink.setStatus;
      pass._setStatus = sink._setStatus;
      pass.setTheme = sink.setTheme;
      pass._rotateStateCookie = sink._rotateStateCookie;
      pass._setKeepCacheDirective = sink._setKeepCacheDirective;
      // ctx.res reads the sink's stub, not the live request's.
      bindRes(pass, () => sink.res);
    },
  },
};

/**
 * Derive a render pass over `base` for `purpose`: `Object.create(base)` with
 * the own fields RENDER_PASS_FIELDS[purpose] declares. The only place a
 * request context is derived (tools/check-internals.mjs).
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
