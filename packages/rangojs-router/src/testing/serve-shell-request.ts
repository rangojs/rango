/**
 * serveShellRequest — one request through the production PPR serve path.
 *
 * Builds the router's request handler as `router.fetch` does
 * (`createRSCHandler` with the router's `nonce` and `cache`
 * config) and serves one GET through it, so middleware, the shell serve path
 * and a MISS's background capture all run production code, on real Flight
 * (the vendored react-server-dom serializer). The call settles every
 * background task the request scheduled before it returns, so a MISS's
 * `putShell` has landed.
 *
 * The one stub is the SSR module (the HTML step): `react-dom/server` refuses
 * to load under the react-server condition this project runs with.
 * - `renderHTML` passes the Flight stream through: a document body is its
 *   Flight payload.
 * - `captureShellHTML` returns, as the prelude, the Flight text the capture
 *   rendered before `quiesce` (plus the post-quiesce task hops the real
 *   capture takes). `postponed` is always null. A capture that does not
 *   quiesce within what `ppr.captureTimeout` leaves after the handler output
 *   settled returns no shell; the real one goes on to its abort and returns
 *   whatever prelude rendered by then.
 * - `resumeShellHTML` passes the tail's Flight stream through: a HIT body is
 *   the stored prelude followed by the tail's Flight payload.
 * So there is no HTML: the prelude's `<body` sanity gate, SSR render errors
 * (production refuses the capture on one), fizz resume of the holes,
 * bootstrap scripts and nonce injection stay e2e-only. A route whose real
 * capture refuses for a root postpone (a live loader read with no boundary
 * above it) or an SSR render error is captured here.
 *
 * A `Prerender` route serves its handler layer from the artifact
 * `router.matchForPrerender` bakes for the URL (on its first request, kept
 * until resetShellTestState), through the production prerender store; an
 * intercept of it serves from the intercept variant the bake keeps. Its
 * first `ppr` request is a MISS with a runtime capture, as a URL without a
 * build-time shell is in production; build-time shells are e2e-only. An
 * on-demand route (`Prerender(..., { onDemand })`) bakes nothing here: it
 * serves from its prerender store, as a refresh-only page does in production.
 *
 * Must run under the `react-server` condition (the rsc Vitest project), with
 * `rangoTestAliases()` resolving `@vitejs/plugin-rsc/rsc/server` to the stub
 * that carries the Flight runtime.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { toInternal, type Rango } from "../router/router-interfaces.js";
import { ensureRouterManifest } from "../route-map-builder.js";
import type { SegmentCacheStore, ShellCacheEntry } from "../cache/types.js";
import {
  awaitLaterMillisecond,
  createCollectingExecutionContext,
} from "../cache/background-task.js";
import type { ExecutionContext } from "../types/request-scope.js";
import type { HandlerCacheConfig, SSRModule } from "../rsc/types.js";
import type { createRSCHandler } from "../rsc/handler.js";
import { setDefaultSSRModuleLoaderForTests } from "../rsc/ssr-module-loader.js";
import {
  POST_QUIESCE_TASK_HOPS,
  SHELL_CAPTURE_MAX_WAIT_MS,
} from "../rsc/shell-capture-constants.js";
import { SEGMENT_FRAGMENT_CAPABILITY_HEADER } from "../segment-fragments.js";
import {
  FILL_PARAM,
  PREFETCH_HEADER,
  STALE_PARAM,
} from "../prefetch-markers.js";
import { resolveDeferredHandleValues } from "../handles/deferred-resolution.js";
import { withoutPushedBy } from "../handles/pushed-by.js";
import type { HandleData } from "../server/handle-store.js";
import type { ResolvedSegment } from "../types.js";
import { revalidationErrorOf } from "../decode-loader-results.js";
import { _getRequestContext } from "../server/request-context.js";
import {
  parsePprReplayStatus,
  parseShellStatus,
  shellCacheKey,
  type PprReplayStatus,
  type ShellStatus,
} from "./shell-status.js";

/** Options for {@link serveShellRequest}. */
export interface ServeShellRequestOptions<TEnv = any> {
  /**
   * The shell and segment store for this request, in place of the router's
   * `createRouter({ cache })` store. The rest of that config (`enabled`,
   * `searchParams`) still applies. Omit it to serve through the router's own
   * store.
   */
  cacheStore?: SegmentCacheStore;
  /** Environment bindings, as `router.fetch(request, { env })` passes them. */
  env?: TEnv;
  /**
   * Request headers. A document request defaults `accept` to `text/html`.
   */
  headers?: HeadersInit;
  /**
   * Serve the client navigation the browser sends (`?_rsc_partial`) instead
   * of a document GET: from `from` (default `/`) with `segments` mounted
   * (default none), advertising fragment passthrough. The replay decision is
   * `result.replayStatus`.
   *
   * `prefetch: true` sends it as a `<Link>` prefetch does (the
   * `X-Rango-Prefetch` header), so `prefetch: false` loaders and `loading()`
   * entries are deferred: `result.readDeferred()` lists them. `fill: true`
   * sends the request the browser follows an adopted prefetch with
   * (`_rsc_fill`): pass the ids the prefetch delivered, without the deferred
   * ones, as `segments`, and the same URL as `from`. `interceptSource` sends
   * the intercept source (`X-RSC-Router-Intercept-Source`) the browser sends
   * from an open modal and with the fill of an intercept, whose `from` is
   * that source. `rewriteTarget` sends the `metadata.rewriteTarget` the page at
   * `from` carried when middleware rewrote it (`_rsc_rt`), as the browser
   * does: the server then diffs against the route that rendered that page.
   * `stale: true` sends a stale request (`_rsc_stale`), as the browser sends
   * it: every `revalidate()` sees `stale: true` (see `revalidate()`'s `stale`)
   * and segments take an action's revalidation defaults; it renders live, as
   * an action does, so neither the route cache nor the document cache answers
   * or stores it, and a `ppr` route's `replayStatus` is
   * `{ outcome: "BYPASS", reason: "stale" }`.
   */
  partial?:
    | true
    | {
        from?: string;
        rewriteTarget?: string;
        segments?: readonly string[];
        prefetch?: boolean;
        fill?: boolean;
        interceptSource?: string;
        stale?: boolean;
      };
  /**
   * POST this form as a submit before hydration: the no-JS request the
   * progressive-enhancement path runs the action for and re-renders the page
   * after. Build it with `createActionForm`. The response is the document
   * (`flight` is its payload, `formState` what the SSR render received).
   * Not with `partial`.
   */
  form?: FormData;
  /**
   * Send the request a JS server action call makes from the page at `url`:
   * a POST of `args` (encoded as the browser encodes them) for `ref`, with
   * the page's mounted `segments` (default none), as
   * browser/server-action-bridge.ts sends it. The response is the action's
   * Flight payload (its return value and the re-rendered segments).
   * Not with `partial` or `form`.
   */
  action?: ServeShellRequestAction;
}

/** The JS server action call of {@link ServeShellRequestOptions.action}. */
export interface ServeShellRequestAction {
  /** The server action. */
  ref: (...args: any[]) => unknown;
  /**
   * Its reference id, `<module id>#<export name>`, as the build gives a
   * "use server" export; registered so the handler loads `ref` by it.
   */
  id: string;
  /** The arguments the page calls it with. */
  args?: readonly unknown[];
  /** The segment ids the page holds (`_rsc_segments`). */
  segments?: readonly string[];
  /** The page's payload `metadata.rewriteTarget`, as for `partial`. */
  rewriteTarget?: string;
}

/** A response's handle data, as the browser consumes it. */
export interface ShellRequestHandles {
  /**
   * What the document hydrates with: `metadata.handles`, read to its end
   * before hydration starts. For a `partial` request, the last state the
   * navigation streamed.
   */
  hydration: HandleData;
  /**
   * The states `metadata.handlesLate` delivered, in order. Each one replaces
   * the client's handle data after hydration. Empty when nothing arrived
   * late, and for a `partial` request.
   */
  late: HandleData[];
}

/**
 * An `action` request's answer, as browser/server-action-bridge.ts reads it.
 */
export interface ShellRequestAction {
  /** False when the action threw: the call rejects with `result`. */
  ok: boolean;
  /** What the call resolves (or rejects) with. */
  result: unknown;
  /**
   * The error of the first loader that threw while it re-ran in the action's
   * revalidation, the value `useAction(action).revalidationError` reports.
   * That loader throws at its `useLoader` read, where the nearest boundary
   * catches it, and the call still resolves. `null` when every loader
   * answered (a `notFound()` or `redirect()` is not an error), or `ok` is
   * false, as `useAction` reports it.
   */
  revalidationError: Error | null;
}

/** Result of {@link serveShellRequest}. */
export interface ServeShellRequestResult {
  /** The handler's Response. Its body is already read: see `body`. */
  response: Response;
  /** The response body text. */
  body: string;
  /** `x-rango-shell` (`HIT` | `MISS`), or null when the header is absent. */
  shellStatus: ShellStatus | null;
  /** `x-rango-ppr-replay` on a partial request, or null. */
  replayStatus: PprReplayStatus | null;
  /**
   * The prelude a HIT served: the capture's Flight text at quiesce (the
   * shell as captured). Undefined unless `shellStatus` is `HIT`.
   */
  prelude: string | undefined;
  /**
   * The Flight payload this request rendered: a HIT's tail, a document's
   * render, or a Flight response. Undefined when no Flight was rendered (a
   * redirect or a middleware response).
   */
  flight: string | undefined;
  /**
   * The shell key production resolved for this request: for a document the
   * serve path read and captured (a MISS or a HIT), the key it used, request
   * partition included (a route partitioned by `cache({ key })` or the
   * store's `keyGenerator`), and for a request middleware rewrote with
   * `rewrite(...).shell("visitor")` the visitor's key, as
   * `visitorShellCacheKey` builds it. Otherwise (a route without `ppr`, a
   * request passed to axis 1 before its key was resolved, a rewritten
   * request whose rewrite chose no shell, a partial request) the document
   * URL's key without a partition, as `shellCacheKey` builds it.
   */
  key: string;
  /**
   * Read the document shell entry under `key` from the request's store
   * (a passive `getShell`), or null. A read, so on a store with a shell memo
   * (CFCacheStore, VercelCacheStore) it warms the memo like any other read.
   */
  readEntry(): Promise<ShellCacheEntry | null>;
  /**
   * Decode the handle data of `flight` as the browser reads it, deferred
   * values resolved. Undefined when no Flight was rendered.
   */
  readHandles(): Promise<ShellRequestHandles | undefined>;
  /**
   * The ids of the segments `flight` marks deferred (a prefetch skipped
   * them; the fill request renders them), in payload order. Empty when
   * nothing was deferred, undefined when no Flight was rendered.
   */
  readDeferred(): Promise<string[] | undefined>;
  /**
   * The form state the SSR render received (the `formState` render option),
   * or undefined when it received none.
   */
  formState: unknown;
  /**
   * The payload's `formState` as the browser reads it, the value the entry
   * hands `hydrateRoot`. Undefined when the payload carries none (or no
   * Flight was rendered). Rejects when the action's state is not
   * Flight-serializable: the document still renders, and the entry
   * hydrates without it.
   */
  readPayloadFormState(): Promise<unknown>;
  /**
   * For an `action` request, the call's answer as the browser reads it: its
   * result and the `revalidationError` its loaders' reruns report.
   * Undefined when no Flight was rendered or the payload carries no action
   * result.
   */
  readAction(): Promise<ShellRequestAction | undefined>;
}

type ShellHandler = ReturnType<typeof createRSCHandler>;

/** What one call's cache resolution and SSR step saw. */
interface Recorder {
  cache?: HandlerCacheConfig;
  /** The shell key the serve path resolved (RequestContext._shellKey). */
  shellKey?: string;
  /** A document render reached the HTML step. */
  rendered?: boolean;
  /** The HIT tail's Flight text. */
  tail?: string;
  /** The formState render option of the document render. */
  formState?: unknown;
}

const recorders = new AsyncLocalStorage<Recorder>();

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Record the shell key the serve path resolved: every SSR step of a document
 * the serve path read runs inside its request context (a capture's derived
 * context inherits it).
 */
function recordShellKey(recorder: Recorder | undefined): void {
  const shellKey = _getRequestContext()?._shellKey;
  if (recorder && shellKey !== undefined) recorder.shellKey ??= shellKey;
}

const SSR_STUB: SSRModule = {
  async renderHTML(rscStream, options) {
    const recorder = recorders.getStore();
    if (recorder) {
      recorder.rendered = true;
      recorder.formState = options?.formState ?? undefined;
    }
    recordShellKey(recorder);
    return rscStream;
  },
  async captureShellHTML(rscStream, options) {
    const reader = rscStream.getReader();
    const decoder = new TextDecoder();
    let frozen = "";
    // The capture gate freezes the stream at quiesce without closing it.
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        frozen += decoder.decode(value, { stream: true });
      }
    })().catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        options.maxWaitMs ?? SHELL_CAPTURE_MAX_WAIT_MS,
      );
    });
    try {
      const quiet = await Promise.race([
        options.quiesce.then(() => true as const),
        deadline,
      ]);
      if (!quiet) return null;
    } finally {
      clearTimeout(timer);
    }
    for (let i = 0; i < POST_QUIESCE_TASK_HOPS; i++) await macrotask();
    return { prelude: new TextEncoder().encode(frozen), postponed: null };
  },
  async resumeShellHTML(rscStream) {
    const recorder = recorders.getStore();
    recordShellKey(recorder);
    // The served HIT's tail only, not a background re-render's.
    if (!recorder || recorder.tail !== undefined) return rscStream;
    recorder.tail = "";
    const decoder = new TextDecoder();
    return rscStream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          recorder.tail += decoder.decode(chunk, { stream: true });
          controller.enqueue(chunk);
        },
        flush() {
          recorder.tail += decoder.decode();
        },
      }),
    );
  },
};

/**
 * `router.prerender()` warms a route through `router.fetch`, whose handler is
 * built with no `loadSSRModule` and so reaches for the Vite RSC module loader
 * this project cannot run. It gets the stub the handlers below get:
 * everything else on a warm's path (router.fetch, createRSCHandler, the match
 * pipeline, the capture) is production code. A warm runs outside a
 * serveShellRequest call, so the stub records nothing for it.
 */
setDefaultSSRModuleLoaderForTests(async () => SSR_STUB);

type HandleChannel = AsyncIterable<HandleData> | undefined;

/** Decode a Flight payload as the browser does. */
async function decodePayload<T>(flight: string): Promise<T> {
  const { deserializeResult } = await import("../cache/segment-codec.js");
  return deserializeResult<T>(flight);
}

/**
 * Read a payload's two handle channels as browser/rsc-router.tsx does:
 * `handles` to its end, then every `handlesLate` state.
 */
async function decodePayloadHandles(
  flight: string,
): Promise<ShellRequestHandles> {
  const { metadata } = await decodePayload<{
    metadata?: { handles?: HandleChannel; handlesLate?: HandleChannel };
  }>(flight);
  let hydration: HandleData = {};
  for await (const data of metadata?.handles ?? []) hydration = data;
  const late: HandleData[] = [];
  for await (const data of metadata?.handlesLate ?? []) {
    late.push(withoutPushedBy(await resolveDeferredHandleValues(data)));
  }
  return {
    hydration: withoutPushedBy(await resolveDeferredHandleValues(hydration)),
    late,
  };
}

/** An action payload's answer, read as the browser's action bridge reads it. */
async function decodeAction(
  flight: string,
): Promise<ShellRequestAction | undefined> {
  const { returnValue, metadata } = await decodePayload<{
    returnValue?: { ok: boolean; data: unknown };
    metadata?: { segments?: ResolvedSegment[] };
  }>(flight);
  if (!returnValue) return undefined;
  return {
    ok: returnValue.ok,
    result: returnValue.data,
    revalidationError:
      (returnValue.ok && (await revalidationErrorOf(metadata?.segments))) ||
      null,
  };
}

/** The ids of the segments a payload marks deferred. */
async function decodeDeferredIds(flight: string): Promise<string[]> {
  const { metadata } = await decodePayload<{
    metadata?: { segments?: Array<{ id: string; deferred?: boolean }> };
  }>(flight);
  return (metadata?.segments ?? [])
    .filter((segment) => segment.deferred === true)
    .map((segment) => segment.id);
}

/**
 * Each router's Prerender artifacts by manifest key, as `vite build` bakes
 * them (router.matchForPrerender), baked on a URL's first request the way the
 * dev server's /__rsc_prerender endpoint bakes them (`devMode`: a Passthrough
 * route keeps getParams()). `baked` holds the pathnames already tried, one
 * that baked nothing (ctx.passthrough()) included.
 */
let prerenderArtifacts = new WeakMap<
  object,
  { payloads: Map<string, string>; baked: Set<string> }
>();

/**
 * Serve a Prerender route's handler layer from its build-time artifact, as
 * production does: through the store the built worker reads
 * (createPrerenderStore over globalThis.__loadPrerenderManifestModule,
 * installed as shell-prerender-phase.ts installs it for build-time shells).
 * `env` stands in for the build's `buildEnv`. Returns the undo, or undefined
 * when `pathname` matches no Prerender route.
 */
async function servePrerenderArtifacts(
  router: Rango<any, any>,
  pathname: string,
  env: unknown,
): Promise<(() => void) | undefined> {
  const internal = toInternal(router);
  const matched = await internal.findMatch(pathname);
  // A build bakes an on-demand route only for the params getParams() lists;
  // a refresh-only page serves from its prerender store alone. A Passthrough
  // route is baked here like a build bakes it: the `devMode` render below
  // asks its getParams() and declines a param it does not list. A plain
  // on-demand route is not: nothing here asks its getParams(), and baking
  // every requested param would hide the 404 an unbaked one answers.
  if (!matched?.pr || (matched.od && !matched.pt)) return undefined;
  let artifacts = prerenderArtifacts.get(router);
  if (!artifacts) {
    prerenderArtifacts.set(
      router,
      (artifacts = { payloads: new Map(), baked: new Set() }),
    );
  }
  const { payloads, baked } = artifacts;
  if (!baked.has(pathname)) {
    const result = await internal.matchForPrerender(
      pathname,
      {},
      undefined,
      matched.pt === true,
      env,
      true,
    );
    const { hashParams } = await import("../prerender/param-hash.js");
    baked.add(pathname);
    if (result && !result.passthrough) {
      const key = `${result.routeName}/${hashParams(result.params)}`;
      payloads.set(
        key,
        JSON.stringify({ segments: result.segments, handles: result.handles }),
      );
      // The intercept variant, keyed and shaped as the build writes it
      // (vite/discovery/prerender-collection.ts).
      if (result.interceptSegments?.length) {
        payloads.set(
          `${key}/i`,
          JSON.stringify({
            segments: [...result.segments, ...result.interceptSegments],
            handles: result.interceptHandles ?? "",
          }),
        );
      }
    }
  }
  const [{ createPrerenderStore }, { setPrerenderStoreForTests }] =
    await Promise.all([
      import("../prerender/store.js"),
      import("../router/match-middleware/cache-lookup.js"),
    ]);
  const previousLoader = globalThis.__loadPrerenderManifestModule;
  globalThis.__loadPrerenderManifestModule = async () => ({
    default: Object.fromEntries([...payloads.keys()].map((key) => [key, key])),
    loadPrerenderAsset: async (key) => ({
      default: JSON.parse(payloads.get(key)!),
    }),
  });
  const previousStore = setPrerenderStoreForTests(createPrerenderStore());
  return () => {
    globalThis.__loadPrerenderManifestModule = previousLoader;
    setPrerenderStoreForTests(previousStore);
  };
}

/**
 * Handlers per router, keyed by the `cacheStore` override or the router. A
 * handler binds its router's document version when it is created, so an entry
 * is reused only while the router would still resolve that version: a
 * setBuildVersions() call (a simulated deploy) that changes it gets a new
 * handler. The data version is read per request, so a data-only change reuses
 * the handler, as a long-lived worker would.
 */
const handlers = new WeakMap<
  object,
  WeakMap<object, { handler: ShellHandler; versions: string }>
>();

async function getHandler(
  router: Rango<any, any>,
  cacheStore: SegmentCacheStore | undefined,
): Promise<ShellHandler> {
  let byStore = handlers.get(router);
  if (!byStore) handlers.set(router, (byStore = new WeakMap()));
  const internal = toInternal(router);
  // Imported here, like the handler below: the module binds the build-only
  // `@rangojs/router:version` virtual, which a flight-only test config (one
  // that never serves a request) does not alias.
  const { resolveRouterVersions } =
    await import("../server/build-version-table.js");
  // What createRSCHandler would resolve for this router now.
  const { document: versions } = resolveRouterVersions(internal.id);
  const cached = byStore.get(cacheStore ?? router);
  if (cached?.versions === versions) return cached.handler;

  const routerCache = internal.cache;
  // Resolved per request, as the handler resolves the router's own config.
  const cache = (env: unknown, ctx?: ExecutionContext): HandlerCacheConfig => {
    const base =
      typeof routerCache === "function" ? routerCache(env, ctx) : routerCache;
    const config = cacheStore ? { ...base, store: cacheStore } : base!;
    const recorder = recorders.getStore();
    if (recorder) recorder.cache = config;
    return config;
  };
  const { createRSCHandler } = await import("../rsc/handler.js");
  const handler = createRSCHandler({
    router: internal,
    nonce: internal.nonce,
    loadSSRModule: async () => SSR_STUB,
    cache: routerCache || cacheStore ? cache : undefined,
  });
  byStore.set(cacheStore ?? router, { handler, versions });
  return handler;
}

async function buildActionRequest(
  url: URL,
  headers: Headers,
  action: ServeShellRequestAction,
): Promise<Request> {
  const [{ registerTestAction }] = await Promise.all([
    import("./internal/test-action.js"),
    import("./internal/flight-client-globals.js"),
  ]);
  const { encodeReply } =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/client.edge");
  registerTestAction(action.ref, action.id, "serveShellRequest");
  const target = new URL(url);
  target.searchParams.set("_rsc_action", action.id);
  target.searchParams.set("_rsc_segments", (action.segments ?? []).join(","));
  if (action.rewriteTarget) {
    target.searchParams.set("_rsc_rt", action.rewriteTarget);
  }
  headers.set("rsc-action", action.id);
  if (!headers.has("X-RSC-Router-Client-Path")) {
    headers.set("X-RSC-Router-Client-Path", url.href);
  }
  return new Request(target, {
    method: "POST",
    headers,
    body: await encodeReply([...(action.args ?? [])]),
  });
}

async function buildRequest(
  url: URL,
  options: ServeShellRequestOptions,
): Promise<Request> {
  const headers = new Headers(options.headers);
  const partial = options.partial;
  if (options.action) {
    if (partial || options.form) {
      throw new Error(
        "serveShellRequest: action cannot be combined with partial or form",
      );
    }
    return buildActionRequest(url, headers, options.action);
  }
  if (options.form) {
    if (partial) {
      throw new Error(
        "serveShellRequest: form cannot be combined with partial",
      );
    }
    return new Request(url, {
      method: "POST",
      headers,
      body: options.form,
    });
  }
  if (!partial) {
    if (!headers.has("accept")) headers.set("accept", "text/html");
    return new Request(url, { headers });
  }
  const {
    from = "/",
    rewriteTarget,
    segments = [],
    prefetch = false,
    fill = false,
    interceptSource,
    stale = false,
  } = partial === true ? {} : partial;
  if (stale && prefetch) {
    throw new Error(
      "serveShellRequest: partial.stale cannot be combined with partial.prefetch",
    );
  }
  const target = new URL(url);
  target.searchParams.set("_rsc_partial", "true");
  target.searchParams.set("_rsc_segments", segments.join(","));
  if (rewriteTarget) target.searchParams.set("_rsc_rt", rewriteTarget);
  // As the browser sends them: browser/navigation-client.ts (fill, stale) and
  // browser/prefetch/fetch.ts (prefetch).
  if (fill) target.searchParams.set(FILL_PARAM, "1");
  if (stale) target.searchParams.set(STALE_PARAM, "true");
  if (prefetch && !headers.has(PREFETCH_HEADER)) {
    headers.set(PREFETCH_HEADER, "1");
  }
  if (!headers.has("X-RSC-Router-Client-Path")) {
    headers.set("X-RSC-Router-Client-Path", new URL(from, url).href);
  }
  if (interceptSource !== undefined) {
    headers.set(
      "X-RSC-Router-Intercept-Source",
      new URL(interceptSource, url).href,
    );
  }
  if (!headers.has(SEGMENT_FRAGMENT_CAPABILITY_HEADER)) {
    headers.set(SEGMENT_FRAGMENT_CAPABILITY_HEADER, "1");
  }
  return new Request(target, { headers });
}

/**
 * Reset the per-isolate PPR state requests leave behind, so the next test
 * starts as a fresh worker would: the capture's stampede guard, its backoff
 * (a refused capture backs its URL off for later tests too), the shell path's
 * once-per-key warnings, the build-shell manifest memo, the "use cache"
 * in-flight leaders and warnings, CFCacheStore's isolate memos (shells,
 * tag markers, tag hints) and warnings, which every CFCacheStore in the
 * process shares by namespace and URL, and the Prerender artifacts baked so
 * far. Call it in `beforeEach`, never while a request is in flight.
 * VercelCacheStore's memos live on the `cache` handle it is given: a new
 * handle starts empty.
 */
export async function resetShellTestState(): Promise<void> {
  prerenderArtifacts = new WeakMap();
  const [capture, serve, buildShells, cf, cacheRuntime, cacheLookup] =
    await Promise.all([
      import("../rsc/shell-capture.js"),
      import("../rsc/shell-serve.js"),
      import("../rsc/shell-build-manifest.js"),
      import("../cache/cf/cf-cache-store.js"),
      import("../cache/cache-runtime.js"),
      import("../router/match-middleware/cache-lookup.js"),
    ]);
  capture.resetShellCaptureStateForTests();
  serve.resetShellServeStateForTests();
  buildShells.resetBuildShellManifestForTests();
  cf.resetCFShellMemoForTests();
  cacheRuntime.resetCacheRuntimeForTests();
  cacheLookup.resetOverlayRevalidationsForTests();
}

/** Settle background tasks, including ones scheduled while settling. */
async function settle(tasks: Promise<unknown>[]): Promise<void> {
  do {
    while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
    await macrotask();
  } while (tasks.length > 0);
}

/**
 * Serve one GET for `url` through the router's production request handler
 * and settle the background tasks it scheduled (a MISS's capture and
 * `putShell` included). The first request for a `ppr` route is a MISS; the
 * next one with the same store is a HIT from the stored shell. The HTML step
 * is stubbed (see the module header), so `prelude` and `flight` are Flight
 * text. The request starts in a later millisecond than the call: a store
 * refuses a capture that starts in the millisecond of a tag invalidation, so
 * an `updateTag()` made just before the call never refuses its recapture.
 * Rejects when the handler throws or the response stream errors (a failing
 * HIT tail), after settling the tasks scheduled so far.
 *
 * @example
 * const store = new MemorySegmentCacheStore();
 * const miss = await serveShellRequest(router, "/product/1", { cacheStore: store });
 * expect(miss.shellStatus).toBe("MISS");
 * const hit = await serveShellRequest(router, "/product/1", { cacheStore: store });
 * expect(hit.shellStatus).toBe("HIT");
 * expect(hit.prelude).toContain("Widget"); // captured shell
 * expect(hit.flight).toContain("in stock"); // live hole, rendered now
 */
export async function serveShellRequest<TEnv = any>(
  router: Rango<TEnv, any>,
  url: string | URL,
  options: ServeShellRequestOptions<TEnv> = {},
): Promise<ServeShellRequestResult> {
  const called = Date.now();
  const target = new URL(url, "http://localhost");
  await ensureRouterManifest(router.id);
  const handler = await getHandler(router, options.cacheStore);
  const request = await buildRequest(target, options);
  const executionContext = createCollectingExecutionContext();
  const { tasks } = executionContext;
  const recorder: Recorder = {};
  const unservePrerender = await servePrerenderArtifacts(
    router,
    target.pathname,
    options.env,
  );
  await awaitLaterMillisecond(called);

  const { response, body } = await recorders.run(recorder, async () => {
    try {
      const response = await handler(request, {
        env: options.env,
        ctx: executionContext,
      });
      return { response, body: await response.text() };
    } finally {
      await settle(tasks);
      unservePrerender?.();
    }
  });

  const config =
    recorder.cache && recorder.cache.enabled !== false
      ? recorder.cache
      : undefined;
  const key =
    recorder.shellKey ?? shellCacheKey(router, target, config?.searchParams);
  const tail = recorder.tail;
  const isFlight =
    recorder.rendered ||
    response.headers.get("content-type")?.includes("text/x-component");
  const prelude =
    tail !== undefined && body.endsWith(tail)
      ? body.slice(0, body.length - tail.length)
      : undefined;
  const flight = tail ?? (isFlight && body ? body : undefined);
  return {
    response,
    body,
    shellStatus: parseShellStatus(response),
    replayStatus: parsePprReplayStatus(response),
    prelude,
    flight,
    key,
    async readEntry() {
      // Passive, like the serve path's own reads: a stale entry's SWR
      // revalidation stays unclaimed for the next request.
      const read = await config?.store.getShell?.(key, {
        claimRevalidation: false,
      });
      return read?.entry ?? null;
    },
    async readHandles() {
      return flight ? decodePayloadHandles(flight) : undefined;
    },
    async readDeferred() {
      return flight ? decodeDeferredIds(flight) : undefined;
    },
    formState: recorder.formState,
    async readPayloadFormState() {
      if (!flight) return undefined;
      const payload = await decodePayload<{
        formState?: Promise<unknown>;
      }>(flight);
      return payload.formState;
    },
    async readAction() {
      return flight ? decodeAction(flight) : undefined;
    },
  };
}
