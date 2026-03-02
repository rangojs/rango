/**
 * Shared dependencies for extracted RSC handler functions.
 *
 * Bundled into a single object by createRSCHandler() and passed to
 * each leaf handler (progressive enhancement, server action, loader fetch,
 * RSC rendering) so they can be standalone modules without closure coupling.
 */

import type { RSCRouterInternal } from "../router/router-interfaces.js";
import type { ErrorPhase } from "../types.js";
import type { InvokeOnErrorContext } from "../router/error-handling.js";
import type { RSCDependencies, LoadSSRModule } from "./types.js";

export interface HandlerContext<TEnv = unknown> {
  router: RSCRouterInternal<TEnv, any>;
  version: string;
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
  ) => Response;
}
