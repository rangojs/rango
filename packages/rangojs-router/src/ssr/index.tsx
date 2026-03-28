import React from "react";
import { setBasename, hasAsyncStorage } from "../browser/basename.js";
import { renderSegments } from "../segment-system.js";
import { filterSegmentOrder } from "../browser/react/filter-segment-order.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import { NonceContext } from "../browser/react/nonce-context.js";
import { NavigationStoreContext } from "../browser/react/context.js";
import type { NavigationStoreContextValue } from "../browser/react/context.js";
import type { HandleData } from "../browser/types.js";
import type { ErrorPhase } from "../types.js";
import type { ResolvedSegment } from "../types.js";
import type { ResolvedThemeConfig, Theme } from "../theme/types.js";
import type {
  EventController,
  DerivedNavigationState,
} from "../browser/event-controller.js";

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
   * createFromReadableStream from @vitejs/plugin-rsc/ssr
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
   * injectRSCPayload from rsc-html-stream/server
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
 * RSC payload type (minimal interface for SSR)
 */
interface RscPayload {
  metadata?: {
    segments?: ResolvedSegment[];
    rootLayout?: React.ComponentType<{ children: React.ReactNode }>;
    handles?: AsyncGenerator<HandleData, void, unknown>;
    matched?: string[];
    pathname?: string;
    params?: Record<string, string>;
    basename?: string;
    themeConfig?: ResolvedThemeConfig | null;
    initialTheme?: Theme;
    version?: string;
  };
}

/**
 * Consume an async generator and return a Promise that resolves with the final value.
 * Used for SSR where we need to await all handle data before rendering.
 */
async function consumeAsyncGenerator(
  generator: AsyncGenerator<HandleData, void, unknown>,
): Promise<HandleData> {
  let lastData: HandleData = {};
  for await (const data of generator) {
    lastData = data;
  }
  return lastData;
}

/**
 * Create a minimal event controller for SSR.
 * This provides the correct pathname so useNavigation returns the right value during SSR.
 */
function createSsrEventController(opts: {
  pathname: string;
  params?: Record<string, string>;
  handleData?: HandleData;
  matched?: string[];
}): EventController {
  const location = new URL(opts.pathname, "http://localhost");
  let params = opts.params ?? {};
  const handleState = {
    data: opts.handleData ?? {},
    segmentOrder: filterSegmentOrder(opts.matched ?? []),
  };
  const state: DerivedNavigationState = {
    state: "idle",
    isStreaming: false,
    isNavigating: false,
    location,
    pendingUrl: null,
    inflightActions: [],
  };

  return {
    getState: () => state,
    getLocation: () => location,
    subscribe: () => () => {},
    getActionState: () => ({
      state: "idle",
      actionId: null,
      payload: null,
      error: null,
      result: null,
    }),
    subscribeToAction: () => () => {},
    subscribeToHandles: () => () => {},
    setHandleData: () => {},
    getHandleState: () => handleState,
    setParams: (nextParams) => {
      params = nextParams;
    },
    getParams: () => params,
    setLocation: () => {},
    startNavigation: () => {
      throw new Error("Navigation not supported during SSR");
    },
    abortNavigation: () => {},
    startAction: () => {
      throw new Error("Actions not supported during SSR");
    },
    abortAllActions: () => {},
    getCurrentNavigation: () => null,
    getInflightActions: () => new Map(),
    hadAnyConcurrentActions: () => false,
  };
}

/**
 * Create an SSR handler that converts RSC streams to HTML.
 *
 * @example
 * ```tsx
 * import { createSSRHandler } from "rsc-router/ssr";
 * import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
 * import { renderToReadableStream } from "react-dom/server.edge";
 * import { injectRSCPayload } from "rsc-html-stream/server";
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

      // Deserialize RSC stream to React tree
      let payload: Promise<RscPayload> | undefined;
      let handlesPromise: Promise<HandleData> | undefined;
      let ssrContextValue: NavigationStoreContextValue | undefined;
      function SsrRoot() {
        payload ??= createFromReadableStream<RscPayload>(rscStream1);
        const resolved = React.use(payload);

        // When ALS is available, basename is already scoped per-request by
        // the RSC handler's runWithBasename(). Only set the module global as
        // a fallback for edge runtimes without async_hooks.
        if (!hasAsyncStorage()) {
          setBasename(resolved.metadata?.basename);
        }

        const themeConfig = resolved.metadata?.themeConfig ?? null;
        const pathname = resolved.metadata?.pathname ?? "/";

        // Await handles before creating SSR event controller so hooks can
        // read request-local handle data via NavigationStoreContext.
        // The handles property is an async generator that yields on each push
        // Memoize the promise since async generators can only be iterated once
        let handleData: HandleData = {};
        if (resolved.metadata?.handles) {
          handlesPromise ??= consumeAsyncGenerator(resolved.metadata.handles);
          handleData = React.use(handlesPromise);
        }

        // Create SSR context with request-local pathname/params/handles.
        ssrContextValue ??= {
          store: null as any,
          eventController: createSsrEventController({
            pathname,
            params: resolved.metadata?.params,
            handleData,
            matched: resolved.metadata?.matched,
          }),
          navigate: async () => {},
          refresh: async () => {},
          version: resolved.metadata?.version,
        };

        // Build content tree from segments.
        // Order must match NavigationProvider: NavigationStoreContext > ThemeProvider > content
        const reconstructedRoot = renderSegments(
          resolved.metadata?.segments ?? [],
          {
            rootLayout: resolved.metadata?.rootLayout,
          },
        );
        let content: React.ReactNode =
          reconstructedRoot instanceof Promise
            ? React.use(reconstructedRoot)
            : reconstructedRoot;

        // Wrap content with ThemeProvider if theme is enabled
        if (themeConfig) {
          content = (
            <ThemeProvider
              config={themeConfig}
              initialTheme={resolved.metadata?.initialTheme}
            >
              {content}
            </ThemeProvider>
          );
        }

        // Wrap with NonceContext so client components (e.g. MetaTags) can
        // apply CSP nonces to inline scripts during SSR. Always present to
        // match the browser-side NavigationProvider tree shape for hydration.
        content = (
          <NonceContext.Provider value={nonce}>{content}</NonceContext.Provider>
        );

        // Wrap with NavigationStoreContext for useNavigation hook
        return (
          <NavigationStoreContext.Provider value={ssrContextValue!}>
            {content}
          </NavigationStoreContext.Provider>
        );
      }

      // Get bootstrap script content
      const bootstrapScriptContent = await loadBootstrapScriptContent();

      // Render React tree to HTML stream
      // Pass formState for useActionState progressive enhancement if provided
      // Pass nonce for CSP if provided
      const htmlStream = await renderToReadableStream(<SsrRoot />, {
        bootstrapScriptContent,
        formState,
        nonce,
      });

      // Wait for all Suspense boundaries to resolve when streamMode is "allReady".
      // This buffers the entire HTML before flushing — used for bots that
      // cannot process streamed HTML.
      if (streamMode === "allReady") {
        await htmlStream.allReady;
      }

      // Inject RSC payload into HTML as <script nonce="...">__FLIGHT_DATA__</script>
      return htmlStream.pipeThrough(injectRSCPayload(rscStream2, { nonce }));
    } catch (error) {
      // Invoke onError callback if provided
      if (onError) {
        const errorObj =
          error instanceof Error ? error : new Error(String(error));
        try {
          onError(errorObj, { phase: "rendering" });
        } catch (callbackError) {
          console.error("[SSRHandler.onError] Callback error:", callbackError);
        }
      }
      throw error;
    }
  };
}
