import React from "react";

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
    options?: { bootstrapScriptContent?: string }
  ) => Promise<ReadableStream<Uint8Array>>;

  /**
   * injectRSCPayload from rsc-html-stream/server
   */
  injectRSCPayload: (
    rscStream: ReadableStream<Uint8Array>
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
    rscStream: ReadableStream<Uint8Array>
  ): Promise<ReadableStream<Uint8Array>> {
    // Tee the stream:
    // - rscStream1: For SSR rendering (deserialize to React VDOM)
    // - rscStream2: For browser hydration (inject as __FLIGHT_DATA__)
    const [rscStream1, rscStream2] = rscStream.tee();

    // Deserialize RSC stream to React tree
    let payload: Promise<RscPayload> | undefined;
    function SsrRoot() {
      payload ??= createFromReadableStream<RscPayload>(rscStream1);
      return React.use(payload).root;
    }

    // Get bootstrap script content
    const bootstrapScriptContent = await loadBootstrapScriptContent();

    // Render React tree to HTML stream
    const htmlStream = await renderToReadableStream(<SsrRoot />, {
      bootstrapScriptContent,
    });

    // Inject RSC payload into HTML as <script>__FLIGHT_DATA__</script>
    return htmlStream.pipeThrough(injectRSCPayload(rscStream2));
  };
}
