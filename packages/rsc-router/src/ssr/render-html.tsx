/**
 * SSR rendering utilities
 * Encapsulates the complexity of converting RSC streams to HTML
 */

import React from "react";
import { Document as DefaultDocument, type DocumentProps } from "./Document.js";

// Vite RSC types
declare global {
  interface ImportMeta {
    viteRsc: {
      loadBootstrapScriptContent(entry: string): Promise<string>;
    };
  }
}

/**
 * RSC payload structure
 */
export interface RscPayload {
  root: React.ReactNode;
  metadata?: {
    pathname: string;
    segments: unknown[];
    isPartial?: boolean;
    matched?: string[];
    diff?: string[];
  };
  returnValue?: { ok: boolean; data: unknown };
}

/**
 * SSR dependencies from @vitejs/plugin-rsc/ssr
 */
export interface SSRDependencies {
  createFromReadableStream<T>(stream: ReadableStream): Promise<T>;
}

/**
 * React DOM SSR dependencies
 */
export interface ReactDOMSSRDependencies {
  renderToReadableStream(
    element: React.ReactElement,
    options?: { bootstrapScriptContent?: string }
  ): Promise<ReadableStream>;
}

/**
 * RSC HTML stream injection function
 */
export type InjectRSCPayload = (
  stream: ReadableStream
) => TransformStream<Uint8Array, Uint8Array>;

/**
 * Configuration for createSSRHandler
 */
export interface CreateSSRHandlerConfig {
  /**
   * SSR dependencies from @vitejs/plugin-rsc/ssr
   */
  deps: SSRDependencies;

  /**
   * React DOM SSR rendering function
   * Import from "react-dom/server.edge"
   */
  renderToReadableStream: ReactDOMSSRDependencies["renderToReadableStream"];

  /**
   * RSC payload injection function
   * Import { injectRSCPayload } from "rsc-html-stream/server"
   */
  injectRSCPayload: InjectRSCPayload;

  /**
   * Custom Document component
   * @default Built-in Document
   */
  Document?: React.ComponentType<DocumentProps>;

}

/**
 * SSR rendering options passed from handler
 */
export interface SSRRenderOptions {
  /**
   * Document loader function for dynamic Document resolution
   * Note: When using createSSRHandler, the Document is configured at creation time,
   * so this option is typically not needed.
   */
  loadDocument?: () => Promise<{ default: React.ComponentType<DocumentProps> }>;
}

/**
 * The renderHTML function signature
 */
export type RenderHTMLFunction = (
  rscStream: ReadableStream<Uint8Array>,
  options?: SSRRenderOptions
) => Promise<ReadableStream<Uint8Array>>;

/**
 * Create an SSR handler for rendering RSC streams to HTML
 *
 * @example
 * ```typescript
 * import { createSSRHandler } from "rsc-router/ssr";
 * import * as ssrDeps from "@vitejs/plugin-rsc/ssr";
 * import { renderToReadableStream } from "react-dom/server.edge";
 * import { injectRSCPayload } from "rsc-html-stream/server";
 * import Document from "./document.js";
 *
 * export const { renderHTML } = createSSRHandler({
 *   deps: ssrDeps,
 *   renderToReadableStream,
 *   injectRSCPayload,
 *   Document,
 * });
 * ```
 */
export function createSSRHandler(config: CreateSSRHandlerConfig): {
  renderHTML: RenderHTMLFunction;
} {
  const {
    deps,
    renderToReadableStream,
    injectRSCPayload,
    Document = DefaultDocument,
  } = config;

  async function renderHTML(
    rscStream: ReadableStream<Uint8Array>,
    _options?: SSRRenderOptions
  ): Promise<ReadableStream<Uint8Array>> {
    // Tee the stream:
    // - rscStream1: For SSR rendering
    // - rscStream2: For browser hydration (injected as __FLIGHT_DATA__)
    const [rscStream1, rscStream2] = rscStream.tee();

    // Deserialize RSC stream to React tree
    let payload: Promise<RscPayload> | undefined;
    function SsrRoot() {
      payload ??= deps.createFromReadableStream<RscPayload>(rscStream1);
      return <Document>{React.use(payload).root}</Document>;
    }

    // Get bootstrap script (must be string literal for Vite RSC static analysis)
    const bootstrapScriptContent =
      await import.meta.viteRsc.loadBootstrapScriptContent("index");

    // Render React tree to HTML stream
    const htmlStream = await renderToReadableStream(<SsrRoot />, {
      bootstrapScriptContent,
    });

    // Inject RSC payload into HTML for hydration
    const responseStream = htmlStream.pipeThrough(injectRSCPayload(rscStream2));

    return responseStream;
  }

  return { renderHTML };
}
