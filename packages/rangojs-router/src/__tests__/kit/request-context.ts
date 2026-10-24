import {
  createRequestContext,
  type CreateRequestContextOptions,
  type RequestContext,
} from "../../server/request-context.js";
import { createHandleStore } from "../../server/handle-store.js";
import { deriveRenderPass } from "../../server/render-pass.js";
import type { ShellCaptureState } from "../../rsc/shell-capture.js";

const DEFAULT_URL = "http://localhost/";

interface KitRequestContextOptions<TEnv> extends Partial<
  Omit<CreateRequestContextOptions<TEnv>, "request" | "url">
> {
  /** The request URL; a path resolves against http://localhost/. */
  url?: string | URL;
  /** Init for the Request built from `url`: headers, method, signal. */
  init?: RequestInit;
}

/**
 * A RequestContext from createRequestContext, the constructor the RSC handler
 * uses. As in testing/internal/context.ts createTestRequestContext, the
 * Request is built from `url`, and `env` and `variables` default to empty.
 * Unlike it, nothing else is seeded: a state cookie name or router versions
 * reach the constructor only when a test passes them.
 */
export function makeRequestContext<TEnv = {}>(
  options: KitRequestContextOptions<TEnv> = {},
): RequestContext<TEnv> {
  const {
    url = DEFAULT_URL,
    init,
    env = {} as TEnv,
    variables = {},
    ...rest
  } = options;
  const request = new Request(new URL(url, DEFAULT_URL), init);
  return createRequestContext<TEnv>({
    ...rest,
    env,
    request,
    url: new URL(request.url),
    variables,
  });
}

/**
 * The ShellCaptureState RENDER_PASS_FIELDS["shell-capture"] creates, with
 * `fields` written over it: for a context a test runs as a shell capture
 * without deriving one.
 */
export function makeShellCaptureState(
  fields: Partial<ShellCaptureState> = {},
): ShellCaptureState {
  const pass = deriveRenderPass(makeRequestContext(), "shell-capture", {
    handleStore: createHandleStore(),
    identity: undefined,
    recording: undefined,
  });
  return Object.assign(pass._shellCaptureState!, fields);
}
