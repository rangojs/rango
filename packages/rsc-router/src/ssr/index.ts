/**
 * rsc-router/ssr
 *
 * SSR utilities for RSC applications
 * Provides default Document component and types for SSR entry configuration
 */

export { Document, PassthroughDocument, type DocumentProps } from "./Document.js";
export {
  createSSRHandler,
  type CreateSSRHandlerConfig,
  type SSRDependencies,
  type ReactDOMSSRDependencies,
  type InjectRSCPayload,
  type RenderHTMLFunction,
  type SSRRenderOptions,
  type RscPayload,
} from "./render-html.js";
