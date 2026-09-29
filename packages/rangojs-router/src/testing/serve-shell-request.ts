/**
 * serveShellRequest — one request through the production PPR serve path.
 *
 * Builds the router's request handler as `router.fetch` does
 * (`createRSCHandler` with the router's `nonce`, `version` and `cache`
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
 *   quiesce within `ppr.captureTimeout` returns no shell; the real one goes
 *   on to its abort and returns whatever prelude rendered by then.
 * - `resumeShellHTML` passes the tail's Flight stream through: a HIT body is
 *   the stored prelude followed by the tail's Flight payload.
 * So there is no HTML: the prelude's `<body` sanity gate, SSR render errors
 * (production refuses the capture on one), fizz resume of the holes,
 * bootstrap scripts and nonce injection stay e2e-only. A route whose real
 * capture refuses for a root postpone (a live loader read with no boundary
 * above it) or an SSR render error is captured here.
 *
 * Must run under the `react-server` condition (the rsc Vitest project), with
 * `rangoTestAliases()` resolving `@vitejs/plugin-rsc/rsc/server` to the stub
 * that carries the Flight runtime.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { toInternal, type Rango } from "../router/router-interfaces.js";
import { ensureRouterManifest } from "../route-map-builder.js";
import type { SegmentCacheStore, ShellCacheEntry } from "../cache/types.js";
import type { ExecutionContext } from "../types/request-scope.js";
import type { HandlerCacheConfig, SSRModule } from "../rsc/types.js";
import type { createRSCHandler } from "../rsc/handler.js";
import {
  POST_QUIESCE_TASK_HOPS,
  SHELL_CAPTURE_MAX_WAIT_MS,
} from "../rsc/shell-capture-constants.js";
import { SEGMENT_FRAGMENT_CAPABILITY_HEADER } from "../segment-fragments.js";
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
   */
  partial?: true | { from?: string; segments?: readonly string[] };
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
  /** The production shell key of the document URL. */
  key: string;
  /**
   * Read the document shell entry under `key` from the request's store
   * (a passive `getShell`), or null. A read, so on a store with a shell memo
   * (CFCacheStore, VercelCacheStore) it warms the memo like any other read.
   */
  readEntry(): Promise<ShellCacheEntry | null>;
}

type ShellHandler = ReturnType<typeof createRSCHandler>;

/** What one call's cache resolution and SSR step saw. */
interface Recorder {
  cache?: HandlerCacheConfig;
  /** A document render reached the HTML step. */
  rendered?: boolean;
  /** The HIT tail's Flight text. */
  tail?: string;
}

const recorders = new AsyncLocalStorage<Recorder>();

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const SSR_STUB: SSRModule = {
  async renderHTML(rscStream) {
    const recorder = recorders.getStore();
    if (recorder) recorder.rendered = true;
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

/** Handlers per router, keyed by the `cacheStore` override or the router. */
const handlers = new WeakMap<object, WeakMap<object, ShellHandler>>();

async function getHandler(
  router: Rango<any, any>,
  cacheStore: SegmentCacheStore | undefined,
): Promise<ShellHandler> {
  let byStore = handlers.get(router);
  if (!byStore) handlers.set(router, (byStore = new WeakMap()));
  const cached = byStore.get(cacheStore ?? router);
  if (cached) return cached;

  const internal = toInternal(router);
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
    version: internal.version,
    loadSSRModule: async () => SSR_STUB,
    cache: routerCache || cacheStore ? cache : undefined,
  });
  byStore.set(cacheStore ?? router, handler);
  return handler;
}

function buildRequest(url: URL, options: ServeShellRequestOptions): Request {
  const headers = new Headers(options.headers);
  const partial = options.partial;
  if (!partial) {
    if (!headers.has("accept")) headers.set("accept", "text/html");
    return new Request(url, { headers });
  }
  const { from = "/", segments = [] } = partial === true ? {} : partial;
  const target = new URL(url);
  target.searchParams.set("_rsc_partial", "true");
  target.searchParams.set("_rsc_segments", segments.join(","));
  if (!headers.has("X-RSC-Router-Client-Path")) {
    headers.set("X-RSC-Router-Client-Path", new URL(from, url).href);
  }
  if (!headers.has(SEGMENT_FRAGMENT_CAPABILITY_HEADER)) {
    headers.set(SEGMENT_FRAGMENT_CAPABILITY_HEADER, "1");
  }
  return new Request(target, { headers });
}

/**
 * Reset the per-isolate PPR state requests leave behind, so the next test
 * starts as a fresh worker would: the capture's stampede guard, its backoff
 * (a refused capture backs its URL off for later tests too), the capture's
 * and the serve path's once-per-key warnings, the build-shell manifest memo,
 * and CFCacheStore's isolate memos (shells, tag markers, tag hints), which
 * every CFCacheStore in the process shares by namespace and URL. Call it in
 * `beforeEach`, never while a request is in flight. VercelCacheStore's memos
 * live on the `cache` handle it is given: a new handle starts empty.
 */
export async function resetShellTestState(): Promise<void> {
  const [capture, serve, buildShells, cf] = await Promise.all([
    import("../rsc/shell-capture.js"),
    import("../rsc/shell-serve.js"),
    import("../rsc/shell-build-manifest.js"),
    import("../cache/cf/cf-cache-store.js"),
  ]);
  capture.resetShellCaptureStateForTests();
  serve.resetShellServeStateForTests();
  buildShells.resetBuildShellManifestForTests();
  cf.resetCFShellMemoForTests();
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
  const request = buildRequest(target, options);
  const tasks: Promise<unknown>[] = [];
  const executionContext: ExecutionContext = {
    waitUntil(promise) {
      tasks.push(
        Promise.resolve(promise).catch((error) =>
          console.error("[waitUntil] Background task failed:", error),
        ),
      );
    },
    passThroughOnException() {},
  };
  const recorder: Recorder = {};
  while (Date.now() === called) await macrotask();

  const { response, body } = await recorders.run(recorder, async () => {
    try {
      const response = await handler(request, {
        env: options.env,
        ctx: executionContext,
      });
      return { response, body: await response.text() };
    } finally {
      await settle(tasks);
    }
  });

  const config =
    recorder.cache && recorder.cache.enabled !== false
      ? recorder.cache
      : undefined;
  const key = shellCacheKey(target, config?.searchParams);
  const tail = recorder.tail;
  const isFlight =
    recorder.rendered ||
    response.headers.get("content-type")?.includes("text/x-component");
  return {
    response,
    body,
    shellStatus: parseShellStatus(response),
    replayStatus: parsePprReplayStatus(response),
    prelude:
      tail !== undefined && body.endsWith(tail)
        ? body.slice(0, body.length - tail.length)
        : undefined,
    flight: tail ?? (isFlight && body ? body : undefined),
    key,
    async readEntry() {
      // Passive, like the serve path's own reads: a stale entry's SWR
      // revalidation stays unclaimed for the next request.
      const read = await config?.store.getShell?.(key, {
        claimRevalidation: false,
      });
      return read?.entry ?? null;
    },
  };
}
