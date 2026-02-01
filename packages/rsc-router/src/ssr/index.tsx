import React from "react";
import { initHandleDataSync } from "../browser/react/use-handle.js";
import { initSegmentsSync } from "../browser/react/use-segments.js";
import { initThemeConfigSync } from "../theme/theme-context.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import type { HandleData } from "../browser/types.js";
import type { ErrorPhase } from "../types.js";
import type { ResolvedThemeConfig, Theme } from "../theme/types.js";

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
}

/**
 * SSR dependencies from external packages
 */
export interface SSRDependencies<TEnv = unknown> {
  /**
   * createFromReadableStream from @vitejs/plugin-rsc/ssr
   */
  createFromReadableStream: <T>(stream: ReadableStream<Uint8Array>) => Promise<T>;

  /**
   * renderToReadableStream from react-dom/server.edge
   */
  renderToReadableStream: (
    element: React.ReactNode,
    options?: RenderToReadableStreamOptions
  ) => Promise<ReadableStream<Uint8Array>>;

  /**
   * injectRSCPayload from rsc-html-stream/server
   */
  injectRSCPayload: (
    rscStream: ReadableStream<Uint8Array>,
    options?: InjectRSCPayloadOptions
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
  root: React.ReactNode;
  metadata?: {
    handles?: AsyncGenerator<HandleData, void, unknown>;
    matched?: string[];
    pathname?: string;
    themeConfig?: ResolvedThemeConfig | null;
    initialTheme?: Theme;
  };
}

/**
 * Consume an async generator and return a Promise that resolves with the final value.
 * Used for SSR where we need to await all handle data before rendering.
 */
async function consumeAsyncGenerator(
  generator: AsyncGenerator<HandleData, void, unknown>
): Promise<HandleData> {
  let lastData: HandleData = {};
  for await (const data of generator) {
    lastData = data;
  }
  return lastData;
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
    options?: SSRRenderOptions
  ): Promise<ReadableStream<Uint8Array>> {
    const { nonce, formState } = options ?? {};

    try {
      // Tee the stream:
      // - rscStream1: For SSR rendering (deserialize to React VDOM)
      // - rscStream2: For browser hydration (inject as __FLIGHT_DATA__)
      const [rscStream1, rscStream2] = rscStream.tee();

      // Deserialize RSC stream to React tree
      let payload: Promise<RscPayload> | undefined;
      let handlesPromise: Promise<HandleData> | undefined;
      function SsrRoot() {
        payload ??= createFromReadableStream<RscPayload>(rscStream1);
        const resolved = React.use(payload);

        // Initialize segments state before children render (for useSegments hook)
        initSegmentsSync(resolved.metadata?.matched, resolved.metadata?.pathname);

        // Initialize theme config for MetaTags to render theme script
        const themeConfig = resolved.metadata?.themeConfig ?? null;
        initThemeConfigSync(themeConfig);

        // Await handles and initialize state before children render
        // The handles property is an async generator that yields on each push
        // Memoize the promise since async generators can only be iterated once
        if (resolved.metadata?.handles) {
          handlesPromise ??= consumeAsyncGenerator(resolved.metadata.handles);
          const handleData = React.use(handlesPromise);
          initHandleDataSync(handleData, resolved.metadata.matched);
        }

        // Wrap content with ThemeProvider if theme is enabled
        // This provides the theme context for client components that use useTheme
        if (themeConfig) {
          return (
            <ThemeProvider config={themeConfig} initialTheme={resolved.metadata?.initialTheme}>
              {resolved.root}
            </ThemeProvider>
          );
        }

        return resolved.root;
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

      // Inject RSC payload into HTML as <script nonce="...">__FLIGHT_DATA__</script>
      return htmlStream.pipeThrough(injectRSCPayload(rscStream2, { nonce }));
    } catch (error) {
      // Invoke onError callback if provided
      if (onError) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
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
