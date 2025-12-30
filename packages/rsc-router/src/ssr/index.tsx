import React from "react";
import { initHandleDataSync } from "../browser/react/use-handle.js";
import { initSegmentsSync } from "../browser/react/use-segments.js";
import type { HandleData } from "../browser/types.js";

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
 * SSR dependencies from external packages
 */
export interface SSRDependencies {
  /**
   * createFromReadableStream from @vitejs/plugin-rsc/ssr
   */
  createFromReadableStream: <T>(stream: ReadableStream<Uint8Array>) => Promise<T>;

  /**
   * renderToReadableStream from react-dom/server.edge
   */
  renderToReadableStream: (
    element: React.ReactNode,
    options?: { bootstrapScriptContent?: string; nonce?: string }
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
 * Options for renderHTML
 */
export interface RenderHTMLOptions {
  /**
   * Nonce for Content Security Policy (CSP)
   */
  nonce?: string;
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
export function createSSRHandler(deps: SSRDependencies) {
  const {
    createFromReadableStream,
    renderToReadableStream,
    injectRSCPayload,
    loadBootstrapScriptContent,
  } = deps;

  /**
   * Render RSC stream to HTML stream
   */
  return async function renderHTML(
    rscStream: ReadableStream<Uint8Array>,
    options?: RenderHTMLOptions
  ): Promise<ReadableStream<Uint8Array>> {
    const { nonce } = options ?? {};
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

      // Await handles and initialize state before children render
      // The handles property is an async generator that yields on each push
      // Memoize the promise since async generators can only be iterated once
      if (resolved.metadata?.handles) {
        handlesPromise ??= consumeAsyncGenerator(resolved.metadata.handles);
        const handleData = React.use(handlesPromise);
        initHandleDataSync(handleData, resolved.metadata.matched);
      }

      return resolved.root;
    }

    // Get bootstrap script content
    const bootstrapScriptContent = await loadBootstrapScriptContent();

    // Render React tree to HTML stream with optional nonce for CSP
    const htmlStream = await renderToReadableStream(<SsrRoot />, {
      bootstrapScriptContent,
      nonce,
    });

    // Inject RSC payload into HTML as <script nonce="...">__FLIGHT_DATA__</script>
    return htmlStream.pipeThrough(injectRSCPayload(rscStream2, { nonce }));
  };
}
