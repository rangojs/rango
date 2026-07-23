import React from "react";
import { createSsrRootComponent } from "./ssr-root.js";
import { injectRSCPayloadEager } from "./inject-rsc-eager.js";
import { runWithPreinitNonce } from "./preinit-client-references.js";
import { SHELL_CAPTURE_MAX_WAIT_MS } from "../rsc/shell-capture-constants.js";
import type { ErrorPhase } from "../types.js";
import type { HeadScriptsOption } from "../vite/plugin-types.js";

export { installClientReferencePreinit } from "./preinit-client-references.js";

/**
 * Options for injectRSCPayload
 */
export interface InjectRSCPayloadOptions {
  /**
   * Nonce for Content Security Policy (CSP)
   */
  nonce?: string;
}

/**
 * Options for renderToReadableStream from react-dom/server
 */
interface RenderToReadableStreamOptions {
  bootstrapScriptContent?: string;
  bootstrapModules?: string[];
  nonce?: string;
  formState?: unknown;
}

/**
 * ReadableStream with the allReady promise added by react-dom/server.edge.
 */
interface ReactDOMReadableStream extends ReadableStream<Uint8Array> {
  allReady: Promise<void>;
}

/**
 * Options for prerender from react-dom/static.edge
 */
interface PrerenderOptions {
  signal?: AbortSignal;
  bootstrapScriptContent?: string;
  bootstrapModules?: string[];
  onError?: (error: unknown) => void;
}

/**
 * Result of prerender from react-dom/static.edge. `postponed` is React's
 * opaque resume state — non-null when the render was aborted with pending
 * holes, null when the shell completed with nothing left to stream.
 */
interface PrerenderResult {
  prelude: ReadableStream<Uint8Array>;
  postponed: unknown;
}

/**
 * prerender from react-dom/static.edge
 */
type PrerenderFn = (
  element: React.ReactNode,
  options?: PrerenderOptions,
) => Promise<PrerenderResult>;

/**
 * Options for resume from react-dom/server.edge
 */
interface ResumeOptions {
  onError?: (error: unknown) => void;
  nonce?: string;
}

/**
 * resume from react-dom/server.edge — continues a prerendered render, emitting
 * only the postponed holes.
 */
type ResumeFn = (
  element: React.ReactNode,
  postponedState: unknown,
  options?: ResumeOptions,
) => Promise<ReactDOMReadableStream>;

/**
 * Options for the renderHTML function
 */
export interface SSRRenderOptions {
  /**
   * Form state for useActionState progressive enhancement.
   * This is the result of decodeFormState() and should be passed to
   * react-dom's renderToReadableStream to enable useActionState to
   * receive the action result during SSR.
   */
  formState?: unknown;

  /**
   * Nonce for Content Security Policy (CSP)
   */
  nonce?: string;

  /**
   * SSR stream mode.
   *
   * - `"stream"` (default) — start flushing HTML immediately.
   * - `"allReady"` — await `stream.allReady` before returning.
   */
  streamMode?: import("../router/router-options.js").SSRStreamMode;
}

/**
 * SSR dependencies from external packages
 */
export interface SSRDependencies<TEnv = unknown> {
  /**
   * createFromReadableStream from @rangojs/router/internal/deps/ssr
   */
  createFromReadableStream: <T>(
    stream: ReadableStream<Uint8Array>,
  ) => Promise<T>;

  /**
   * renderToReadableStream from react-dom/server.edge
   */
  renderToReadableStream: (
    element: React.ReactNode,
    options?: RenderToReadableStreamOptions,
  ) => Promise<ReactDOMReadableStream>;

  /**
   * injectRSCPayload from @rangojs/router/internal/deps/html-stream-server
   */
  injectRSCPayload: (
    rscStream: ReadableStream<Uint8Array>,
    options?: InjectRSCPayloadOptions,
  ) => TransformStream<Uint8Array, Uint8Array>;

  /**
   * Function to load bootstrap script content
   * Typically: () => import.meta.viteRsc.loadBootstrapScriptContent("index")
   */
  loadBootstrapScriptContent: () => Promise<string>;

  /**
   * Document script strategy; the generated virtual SSR entry threads the
   * `rango({ headScripts })` plugin option here (canonical docs on
   * `RangoBaseOptions.headScripts` in vite/plugin-types.ts). The
   * bootstrapModules conversion runs ONLY on an explicit `"preinit"`:
   * undefined keeps the inline bootstrap verbatim, so a custom SSR entry that
   * never installed the preinit hook cannot drift into the half-converted
   * state on upgrade (the generated entry always passes an explicit value).
   */
  headScripts?: HeadScriptsOption;

  /**
   * prerender from react-dom/static.edge. Optional; required only by
   * {@link createShellCaptureHandler} for PPR shell capture.
   */
  prerender?: PrerenderFn;

  /**
   * resume from react-dom/server.edge. Optional; required only by
   * {@link createShellResumeHandler} for resuming a postponed shell.
   */
  resume?: ResumeFn;

  /**
   * Optional callback invoked when an error occurs during SSR rendering.
   *
   * This callback is for notification/logging purposes.
   *
   * @example
   * ```typescript
   * export const renderHTML = createSSRHandler({
   *   // ... other deps
   *   onError: (error, context) => {
   *     console.error('[SSR] Rendering error:', error);
   *     Sentry.captureException(error);
   *   },
   * });
   * ```
   */
  onError?: (error: Error, context: { phase: ErrorPhase }) => void;
}

/**
 * Fixed number of macrotask hops between `quiesce` resolving and the abort. These
 * give React's fizz worker turns to flush the settled shell into the prelude and
 * mark still-pending boundaries as POSTPONED (rather than errored) before
 * controller.abort() lands. Not a wall-clock wait.
 *
 * Why 16 and not the original 2: under the REPLAY-ONLY capture model
 * (docs/design/ppr-shell-resume.md), the capture Flight render serializes ring-3
 * cached segments that are ALREADY serialized, so it emits the whole shell payload
 * in the first tick and the gate declares quiesce almost immediately (~a few ms).
 * On the old fresh-execution path the Flight dribbled out as handlers ran, so
 * Flight-quiet effectively meant "the shell has rendered" and 2 hops sufficed.
 *
 * Hops alone are NOT render-readiness: fizz cannot emit even <html> until the
 * payload root settles, which waits on every referenced client-module LOAD —
 * real module-runner I/O in dev (100ms+ cold), which no fixed count of near-
 * zero-cost task hops can buy. captureShellHTML therefore awaits the payload-
 * settled signal (SsrRootOptions.onPayloadSettled, deadline-bounded) between
 * quiesce and these hops; the hops then only flush the settled tree and mark
 * pending boundaries POSTPONED. Still task-based (masked loaders never emit,
 * so more hops never lets a hole settle). Bounded by maxWaitMs end to end.
 */
const POST_QUIESCE_TASK_HOPS = 16;

/**
 * Route an SSR error through the deps.onError notification callback with the
 * "rendering" phase. Swallows callback failures so a broken reporter never
 * masks the original error. Shared by renderHTML, capture, and resume so the
 * onError contract is identical across all three handlers.
 */
function reportRenderError(
  onError: SSRDependencies["onError"],
  error: unknown,
): void {
  if (onError) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    try {
      onError(errorObj, { phase: "rendering" });
    } catch (callbackError) {
      console.error("[SSRHandler.onError] Callback error:", callbackError);
    }
  }
}

/**
 * Yield one macrotask. Used by capture to let React's fizz worker flush the
 * shell and mark still-pending boundaries as postponed before the abort.
 */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A timeout promise paired with a cancel() so the pending timer is cleared once
 * the race is decided — otherwise the maxWait timer keeps the event loop alive
 * for the full duration even after `quiesce` won.
 */
function createCancelableTimeout(ms: number): {
  promise: Promise<void>;
  cancel: () => void;
} {
  let id: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    id = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(id) };
}

/**
 * True when a debugger is attached outside a production build: a breakpoint
 * pauses script execution but not wall-clock, so the capture deadline would
 * expire mid-inspection and push the key into refusal/backoff while debugging.
 * Next.js precedent (packages/next/src/export/worker.ts): its static-page
 * timeout race is disabled when NODE_OPTIONS contains --inspect. The gate is
 * the bare `process.env.NODE_ENV !== "production"` token — the build define
 * folds exactly that token to a literal (same dev signal as shell-capture.ts's
 * isDevMode), and it covers dev servers that never set NODE_ENV, the common
 * debug case. A production worker launched with --inspect in NODE_OPTIONS
 * keeps the capture's safety bound unconditionally. Every probe is guarded:
 * `process` reads are optional-chained and the node:inspector import is
 * try/caught, so non-Node runtimes (workerd) resolve to false instead of
 * breaking.
 */
export async function isDebuggerAttached(): Promise<boolean> {
  if (process.env.NODE_ENV === "production") return false;
  try {
    // Substring match also catches --inspect-brk / --inspect=PORT.
    if (globalThis.process?.env?.NODE_OPTIONS?.includes("--inspect")) {
      return true;
    }
    if (globalThis.process?.execArgv?.some((a) => a.startsWith("--inspect"))) {
      return true;
    }
    const inspector = await import("node:inspector");
    return inspector.url() !== undefined;
  } catch {
    return false;
  }
}

/**
 * Drain a ReadableStream fully into a single Uint8Array. Capture buffers the
 * whole prelude so it can be stored and later prepended byte-for-byte.
 */
async function readStreamToUint8Array(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch (error) {
    // Mid-read abort path (documented): the prelude stream errors with our
    // abort reason while we are still reading it. Cancel the source before
    // rethrowing so it is not left uncancelled; releaseLock always runs in
    // finally. Mirrors src/rsc/rsc-rendering.ts's serve-side reader cleanup.
    reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * A minimal HTML stream for the resume DATA variant: one empty chunk, then
 * close.
 *
 * injectRSCPayload only resolves its internal flight-data promise (and thus
 * only writes the Flight payload <script> pushes) from inside transform()'s
 * scheduled callback. A stream that closes without ever emitting a chunk never
 * runs transform, so its flush() awaits a promise that is never resolved and
 * the output deadlocks. Emitting a single empty chunk runs transform once,
 * which is enough for the payload to be written and the trailer appended.
 */
function createDataVariantHtmlStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(0));
      controller.close();
    },
  });
}

/**
 * Options for the captureShellHTML function returned by
 * {@link createShellCaptureHandler}.
 */
interface ShellCaptureOptions {
  /** Caller-provided promise that resolves once the cached content settled. */
  quiesce: Promise<void>;
  /** Upper bound on how long to wait for `quiesce`. Default SHELL_CAPTURE_MAX_WAIT_MS. */
  maxWaitMs?: number;
}

/**
 * Result of a successful shell capture. `prelude` is the raw prelude bytes;
 * `postponed` is React's resume state serialized to JSON, or null when the
 * shell completed with no holes (the DATA variant).
 */
interface ShellCaptureResult {
  prelude: Uint8Array;
  postponed: string | null;
}

/**
 * Options for the resumeShellHTML function returned by
 * {@link createShellResumeHandler}.
 */
interface ShellResumeOptions {
  /** JSON from capture; null selects the DATA variant (no fizz). */
  postponed: string | null;
  /** Nonce for CSP. */
  nonce?: string;
}

/**
 * The exact shape plugin-rsc's loadBootstrapScriptContent returns in both dev
 * and build: a single dynamic import of the browser entry, nothing else.
 * Escapes/other statements never appear in that generated content; anything
 * that doesn't match falls back to inline bootstrapScriptContent unchanged.
 */
const BOOTSTRAP_IMPORT_ONLY_RE =
  /^\s*import\(\s*(["'])([^"'\\]+)\1\s*\)\s*;?\s*$/;

/**
 * Prefer bootstrapModules over the inline import() bootstrap. When the content
 * is exactly `import("<entry-url>")`, hand Fizz the URL instead: React then
 * emits a `<link rel="modulepreload" fetchpriority="low">` hint in the head
 * plus the executing `<script type="module" src async>` at end of shell — the
 * entry fetch starts with the first flushed bytes instead of when the parser
 * reaches an opaque inline script that only reveals the URL once executed.
 * Fizz stamps the request nonce on both tags (the inline form needed that
 * too), and under PPR both land in the stored prelude; on resume React has
 * already cleared the bootstrap fields from the postponed state, so nothing
 * re-emits.
 */
function resolveBootstrapOptions(
  content: string,
  headScripts: SSRDependencies["headScripts"],
): Pick<
  RenderToReadableStreamOptions,
  "bootstrapScriptContent" | "bootstrapModules"
> {
  // Explicit opt-in only: undefined (a custom SSR entry that predates the
  // option, which also never installed the preinit hook) keeps the inline
  // bootstrap byte-for-byte — converting by default would break CSPs that
  // allowlist the known inline import() via a script hash.
  if (headScripts !== "preinit") {
    return { bootstrapScriptContent: content };
  }
  const match = BOOTSTRAP_IMPORT_ONLY_RE.exec(content);
  return match
    ? { bootstrapModules: [match[2]!] }
    : { bootstrapScriptContent: content };
}

/**
 * Create an SSR handler that converts RSC streams to HTML.
 *
 * @example
 * ```tsx
 * import { createSSRHandler } from "@rangojs/router/ssr";
 * import { createFromReadableStream } from "@rangojs/router/internal/deps/ssr";
 * import { renderToReadableStream } from "react-dom/server.edge";
 * import { injectRSCPayload } from "@rangojs/router/internal/deps/html-stream-server";
 *
 * export const renderHTML = createSSRHandler({
 *   createFromReadableStream,
 *   renderToReadableStream,
 *   injectRSCPayload,
 *   loadBootstrapScriptContent: () =>
 *     import.meta.viteRsc.loadBootstrapScriptContent("index"),
 * });
 * ```
 */
export function createSSRHandler<TEnv = unknown>(deps: SSRDependencies<TEnv>) {
  const {
    createFromReadableStream,
    renderToReadableStream,
    injectRSCPayload,
    loadBootstrapScriptContent,
    onError,
  } = deps;

  /**
   * Render RSC stream to HTML stream
   *
   * @param rscStream - The RSC stream to render
   * @param options - Optional render options including formState for useActionState and nonce for CSP
   */
  return async function renderHTML(
    rscStream: ReadableStream<Uint8Array>,
    options?: SSRRenderOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const { nonce, formState, streamMode } = options ?? {};

    try {
      // Tee the stream:
      // - rscStream1: For SSR rendering (deserialize to React VDOM)
      // - rscStream2: For browser hydration (inject as __FLIGHT_DATA__)
      const [rscStream1, rscStream2] = rscStream.tee();

      const SsrRoot = createSsrRootComponent({
        createFromReadableStream,
        rscStream: rscStream1,
        nonce,
      });

      // Get bootstrap script content
      const bootstrapScriptContent = await loadBootstrapScriptContent();

      // Render React tree to HTML stream
      // Pass formState for useActionState progressive enhancement if provided
      // Pass nonce for CSP if provided. runWithPreinitNonce makes the same
      // nonce visible to the client-reference preinit hook (ALS — the hook is
      // isolate-global, the nonce per request).
      const htmlStream = await runWithPreinitNonce(nonce, () =>
        renderToReadableStream(<SsrRoot />, {
          ...resolveBootstrapOptions(bootstrapScriptContent, deps.headScripts),
          formState,
          nonce,
        }),
      );

      // Wait for all Suspense boundaries to resolve when streamMode is "allReady".
      // This buffers the entire HTML before flushing — used for bots that
      // cannot process streamed HTML.
      if (streamMode === "allReady") {
        await htmlStream.allReady;
      }

      // Inject RSC payload into HTML as <script nonce="...">__FLIGHT_DATA__</script>
      return htmlStream.pipeThrough(injectRSCPayload(rscStream2, { nonce }));
    } catch (error) {
      reportRenderError(onError, error);
      throw error;
    }
  };
}

/**
 * Create the PPR shell capture handler.
 *
 * captureShellHTML prerenders the shell over the (cached, loader-masked) Flight
 * stream, aborts once the shell settles, and returns the prelude bytes plus the
 * postponed resume state for storage. The stored pair is later served by
 * {@link createShellResumeHandler}. See docs/design/ppr-shell-resume.md.
 *
 * Throws at creation if `deps.prerender` is missing — capture cannot run
 * without react-dom/static.edge's prerender.
 */
export function createShellCaptureHandler<TEnv = unknown>(
  deps: SSRDependencies<TEnv>,
) {
  const { createFromReadableStream, loadBootstrapScriptContent, prerender } =
    deps;
  const onError = deps.onError;

  if (!prerender) {
    throw new Error(
      "[createShellCaptureHandler] Missing `prerender` dependency (react-dom/static.edge). " +
        "PPR shell capture requires the prerender export; wire it in the SSR virtual entry.",
    );
  }

  /**
   * Prerender the shell and return the stored artifacts, or null when the
   * shell degraded (root postpone / hung handles) and must not be cached.
   *
   * @param rscStream - Flight stream to render the shell over. Not teed and not
   *   piped through injectRSCPayload: the hydration payload is produced fresh
   *   per request by the resume/serve pass.
   * @param opts - quiesce signal and maxWait guard.
   */
  return async function captureShellHTML(
    rscStream: ReadableStream<Uint8Array>,
    opts: ShellCaptureOptions,
  ): Promise<ShellCaptureResult | null> {
    const maxWaitMs = opts.maxWaitMs ?? SHELL_CAPTURE_MAX_WAIT_MS;

    // Arm the maxWaitMs deadline BEFORE the first await so it bounds the ENTIRE
    // capture, the bootstrap-script load included. loadBootstrapScriptContent()
    // used to run before the timer, so a hung/slow bootstrap load hung
    // captureShellHTML with no upper bound and held the background capture task
    // open. One deadline, shared by the bootstrap race below and the quiesce
    // race, keeps the whole path "bounded by maxWaitMs like every quiesce input".
    // Debugger attached (non-production, see isDebuggerAttached): a paused process
    // must not burn the budget, so the deadline becomes a never-resolving
    // promise (the Next.js approach) — no timer, so it cannot hold the event
    // loop open either.
    const deadline = (await isDebuggerAttached())
      ? { promise: new Promise<void>(() => {}), cancel: () => {} }
      : createCancelableTimeout(maxWaitMs);
    try {
      // No nonce (nonce'd requests never reach capture); no formState.
      // payloadSettled: fires when the Flight payload root settles — i.e.
      // every client-module load the payload references completed and fizz
      // can actually emit the tree. The abort below gates on it (bounded by
      // the same deadline): Flight byte-quiet alone is NOT render-readiness.
      let settlePayload!: () => void;
      const payloadSettled = new Promise<void>((resolve) => {
        settlePayload = resolve;
      });
      const SsrRoot = createSsrRootComponent({
        createFromReadableStream,
        rscStream,
        onPayloadSettled: settlePayload,
      });

      // Bootstrap load raced against the deadline. A load that never resolves
      // within maxWaitMs is the same bounded no-shell degrade as a shell that
      // never goes quiet: return null, do not hang. A load that REJECTS is a
      // genuine error and still propagates (it is not the deadline). `null` is
      // the deadline sentinel — disjoint from the load's `Promise<string>`, so
      // the race narrows to `string | null` with no wrapper. The no-op catch
      // keeps a late rejection off the unhandledRejection path when the deadline
      // already won; a rejection that lands first still propagates out.
      const load = loadBootstrapScriptContent();
      load.catch(() => {});
      const bootstrapScriptContent = await Promise.race([
        load,
        deadline.promise.then(() => null),
      ]);
      if (bootstrapScriptContent === null) {
        return null;
      }

      // Start prerender first, then run the abort schedule concurrently. When
      // holes are pending, prerender's promise settles only after abort(); when
      // the shell completes with no holes it settles on its own and the later
      // abort() is a harmless no-op (the DATA variant).
      const controller = new AbortController();
      // Private reason object: the deliberate abort is identified by object
      // IDENTITY in both the onError below and the post-await catch. React
      // propagates this EXACT object to onError for every still-pending boundary
      // (verified identity-preserving), and rejects/errors the prelude with it.
      const abortReason = { rangoShellCaptureAbort: true };
      const prerenderPromise = prerender(<SsrRoot />, {
        signal: controller.signal,
        ...resolveBootstrapOptions(bootstrapScriptContent, deps.headScripts),
        // Abort is how capture WORKS: once the shell is quiet we abort() to
        // freeze the prelude and let the still-pending holes postpone. React
        // reports the abort reason for each pending boundary through onError.
        // Without an onError here React falls back to console.error, so every
        // capture that still has a live hole at abort time (the normal case)
        // dumps a stack once per pending boundary. That is EXPECTED degradation,
        // so swallow OUR abort — matched by IDENTITY (error === abortReason).
        // Discriminate by identity, NOT error.name: capture aborts before
        // awaiting, so signal.aborted is unconditionally true and a name check
        // swallowed genuine AbortError-named throws (a component's own
        // fetch/AbortController cancellation) as if they were our abort. Genuine
        // render errors are NOT our sentinel and still surface through
        // deps.onError, the same channel renderHTML uses. See
        // docs/design/ppr-shell-resume.md.
        onError: (error: unknown) => {
          if (error === abortReason) {
            return;
          }
          reportRenderError(onError, error);
        },
      });
      // Pre-attach a no-op catch: the real await sits AFTER quiesce + the
      // post-quiesce hops, so an early prerender rejection (e.g. a bake-lane
      // loader tripping the identity guard within milliseconds) would otherwise
      // spend several turns handler-less and crash the worker as an unhandled
      // rejection. The actual rejection handling still happens at the await
      // below; this parallel handler only keeps the gap crash-free.
      prerenderPromise.catch(() => {});

      // Wait for the caller's quiesce signal, bounded by the SAME deadline. By
      // the time it resolves the Flight input is byte-quiet and FROZEN by the
      // capture gate (shell-capture.ts gateFlightForCapture), so there is no
      // wall-clock debounce here — maxWaitMs is only the pathological guard for a
      // shell that never goes quiet (a root postpone / hung handle).
      await Promise.race([opts.quiesce, deadline.promise]);
      // Then wait for fizz RENDER-READINESS, bounded by the same deadline:
      // the payload root settles only after every client-module load the
      // payload references completed (real module-runner I/O in dev; 100ms+
      // on a cold graph). Flight byte-quiet does NOT imply this — a fully
      // REPLAYED (prerendered) route's Flight stream finishes in ~1-3ms and
      // an abort taken on quiet-plus-task-hops alone landed BEFORE fizz could
      // emit <html>, freezing a zero-byte prelude: the eternal-MISS shape
      // this route class showed on every cold graph (dev cold boots, GH
      // runners) while ordinary routes — whose live handler execution keeps
      // Flight noisy long enough — never hit it. Masked-loader holes do not
      // block payload settlement (they postpone below the root), so this
      // await costs a genuinely hole-y shell nothing; a payload that NEVER
      // settles (hung handles) degrades at the deadline exactly as before.
      // A prerender that SETTLES first (early success or a hard rejection)
      // ends the wait immediately — fizz is already done either way.
      const prerenderSettled = prerenderPromise.then(
        () => {},
        () => {},
      );
      await Promise.race([payloadSettled, prerenderSettled, deadline.promise]);
      // Fixed task hops before the abort: give React's fizz worker turns to flush
      // the now-complete shell and mark the still-pending boundaries as POSTPONED
      // rather than errored. Deterministic (the byte set is already frozen and
      // the payload is settled), so a fixed count of turns suffices — no
      // wall-clock. Ready-but-queued fizz render work (however large — a multi-MB
      // outlined boundary) can never lose this race: tracked-postpones pings run
      // on scheduleMicrotask, so every runnable task drains before the FIRST
      // setTimeout hop fires; only tasks parked on genuinely pending promises
      // (masked loaders, real per-request I/O) remain, and those are exactly the
      // holes that must postpone (issue #702).
      for (let i = 0; i < POST_QUIESCE_TASK_HOPS; i++) {
        await macrotask();
      }
      controller.abort(abortReason);

      // A hard prerender rejection (fatal shell error) propagates. Expected
      // degradation surfaces three ways and all return null: a trivial prelude
      // (sanity gate below), the prerender REJECTING with our abort reason, or
      // the prelude STREAM erroring with our abort reason mid-read — both abort
      // shapes happen when our own abort lands before the shell completed (seen
      // on dev cold paths, where module transform / first-render latency
      // outlasts flight quiesce; a later request re-captures against warm
      // modules and succeeds).
      let prelude: Uint8Array;
      let postponed: unknown;
      try {
        const result = await prerenderPromise;
        prelude = await readStreamToUint8Array(result.prelude);
        postponed = result.postponed;
      } catch (error) {
        // Identity match: swallow ONLY our own deliberate abort
        // (error === abortReason). Not error.name — capture aborts before this
        // await, so signal.aborted is always true, and a name check let a
        // genuine AbortError-named throw masquerade as our abort and degrade
        // into a retryable no-shell, hiding real failures from reportCacheError.
        if (error === abortReason) {
          return null;
        }
        throw error;
      }

      // Sanity gate: a prelude with no `<body` is the no-shell failure mode.
      // Return null and store nothing; the request falls back to axis 1 and a
      // later request re-captures. The dominant real-world cause is a loader
      // route WITHOUT a route-level loading() boundary: renderSegments' loading-
      // less branch awaits loader data at TREE-BUILD, so the masked loader pins
      // the whole tree above <body> (root postpone). Root-postponing layouts and
      // hung handles degrade the same way. shell-capture.ts logs a once-per-key
      // warning so the eternal-MISS shape is diagnosable.
      if (!new TextDecoder().decode(prelude).includes("<body")) {
        return null;
      }

      return {
        prelude,
        postponed: postponed == null ? null : JSON.stringify(postponed),
      };
    } finally {
      deadline.cancel();
    }
  };
}

/**
 * Create the PPR shell resume handler.
 *
 * resumeShellHTML produces the per-request live portion of the document: for a
 * postponed shell it resumes fizz over a fresh SsrRoot to emit only the holes;
 * for the DATA variant it emits only the fresh Flight payload scripts. The
 * caller (shell-cache middleware) prepends the stored prelude bytes to form the
 * composite response. See docs/design/ppr-shell-resume.md.
 */
export function createShellResumeHandler<TEnv = unknown>(
  deps: SSRDependencies<TEnv>,
) {
  const { createFromReadableStream, resume, onError } = deps;

  /**
   * @param rscStream - Fresh full Flight stream for this request.
   * @param opts - postponed state (null = DATA variant) and optional nonce.
   */
  return async function resumeShellHTML(
    rscStream: ReadableStream<Uint8Array>,
    opts: ShellResumeOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const { postponed, nonce } = opts;

    try {
      if (postponed === null) {
        // DATA variant: the stored prelude is the complete shell. No fizz runs;
        // the eager injector pumps the fresh Flight payload scripts without
        // needing an HTML chunk to trigger it (the stock injector deadlocked on
        // a chunkless stream — see createDataVariantHtmlStream, kept for the
        // batching invariant's sake).
        return createDataVariantHtmlStream().pipeThrough(
          injectRSCPayloadEager(rscStream, { nonce }),
        );
      }

      if (!resume) {
        throw new Error(
          "[createShellResumeHandler] Missing `resume` dependency (react-dom/server.edge). " +
            "Resuming a postponed shell requires the resume export; wire it in the SSR virtual entry.",
        );
      }

      // Tee: one branch deserializes into the SsrRoot VDOM that resume() replays
      // (a fresh instance is fine — replay matches structure, not identity), the
      // other feeds the fresh hydration payload to injectRSCPayload.
      const [rscStream1, rscStream2] = rscStream.tee();

      const SsrRoot = createSsrRootComponent({
        createFromReadableStream,
        rscStream: rscStream1,
        nonce,
      });

      // EAGER injection (resume-only): the stored prelude — a complete document
      // through </body></html> — is already on the wire ahead of this stream,
      // so a Flight <script> is valid as the first tail byte. The stock
      // injector waits for the first fizz chunk, which only appears when the
      // first hole's loaders resolve — parking the whole hydration payload
      // (root row included) behind the slowest live loader. See
      // inject-rsc-eager.ts for the measured failure mode.
      //
      // EAGER HANDOVER: return the injector's readable BEFORE awaiting
      // resume(). react-dom's resume() promise resolves only when the resumed
      // shell (everything above the postponed holes) completes — which waits
      // on the live loaders — so `await resume(...).pipeThrough(...)` parked
      // the already-flowing Flight bytes a second time, behind the handshake
      // instead of the stream (measured: injector output at +9ms, first tail
      // byte on the wire at +735ms). Piping fizz in when it materializes lets
      // serveShellHit start draining Flight immediately; pipeTo closes the
      // writable on completion, which runs the injector's flush (trailer). A
      // resume() rejection aborts the writable so the response errors instead
      // of hanging.
      const injector = injectRSCPayloadEager(rscStream2, { nonce });
      void (async () => {
        try {
          // Nonce wrap mirrors renderHTML: client references first discovered
          // during resume (holes the shell never rendered) preinit into the
          // resumed stream and need the per-request nonce.
          const resumed = await runWithPreinitNonce(nonce, () =>
            resume(<SsrRoot />, JSON.parse(postponed), {
              onError: (error) => reportRenderError(onError, error),
              nonce,
            }),
          );
          await resumed.pipeTo(injector.writable);
        } catch (error) {
          reportRenderError(onError, error);
          try {
            await injector.writable.abort(error);
          } catch {
            // Writable already errored/closed; the readable side has the error.
          }
        }
      })();
      return injector.readable;
    } catch (error) {
      reportRenderError(onError, error);
      throw error;
    }
  };
}
