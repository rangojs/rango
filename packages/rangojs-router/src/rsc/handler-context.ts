/**
 * Shared dependencies for extracted RSC handler functions.
 *
 * Bundled into a single object by createRSCHandler() and passed to
 * each leaf handler (progressive enhancement, server action, loader fetch,
 * RSC rendering) so they can be standalone modules without closure coupling.
 */

import type { RangoInternal } from "../router/router-interfaces.js";
import type { ErrorPhase } from "../types.js";
import type { InvokeOnErrorContext } from "../router/error-handling.js";
import type { RSCDependencies, LoadSSRModule } from "./types.js";
import type { SSRStreamMode } from "../router/router-options.js";

export interface HandlerContext<TEnv = unknown> {
  router: RangoInternal<TEnv, any>;
  /**
   * The router's DOCUMENT version (router-versions.ts): payload metadata, the
   * `_rsc_v` reload check, and PPR shell stamping and gating. The data version
   * is not here; cache stores read it from the request context.
   */
  version: string;
  devDiscoveryEpoch?: number;
  renderToReadableStream: RSCDependencies["renderToReadableStream"];
  decodeReply: RSCDependencies["decodeReply"];
  createTemporaryReferenceSet: RSCDependencies["createTemporaryReferenceSet"];
  loadServerAction: RSCDependencies["loadServerAction"];
  decodeAction: RSCDependencies["decodeAction"];
  decodeFormState: RSCDependencies["decodeFormState"];
  loadSSRModule: LoadSSRModule;
  callOnError: (
    error: unknown,
    phase: ErrorPhase,
    context: InvokeOnErrorContext<TEnv>,
  ) => void;
  getRequiredRouteMap: () => Record<string, string>;
  createRedirectFlightResponse: (
    redirectUrl: string,
    locationState?: Record<string, unknown>,
    external?: boolean,
  ) => Response;

  /**
   * Resolve the SSR stream mode for a given request.
   * Returns "stream" when no resolveStreaming callback is configured.
   */
  resolveStreamMode: (
    request: Request,
    env: TEnv,
    url: URL,
  ) => Promise<SSRStreamMode>;
}
