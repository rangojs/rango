import {
  createRequestContext,
  type CreateRequestContextOptions,
  type RequestContext,
} from "../../server/request-context.js";

export interface KitRequestContextOptions<TEnv> extends Partial<
  Omit<CreateRequestContextOptions<TEnv>, "request" | "url">
> {
  /** The request URL. Default `https://example.com/`. */
  url?: string;
  /** Init for the `Request` built from `url` (headers, method, signal, ...). */
  requestInit?: RequestInit;
}

/**
 * A real `RequestContext` from the production `createRequestContext`, built
 * the way `createTestRequestContext` (`src/testing/internal/context.ts`) builds
 * it: one `Request`, its `URL`, `env` and `variables` defaulting to `{}`. Every
 * other `CreateRequestContextOptions` field passes through unchanged.
 *
 * Enter it with `runWithRequestContext(ctx, fn)` before code that calls
 * `getRequestContext()`.
 */
export function makeRequestContext<TEnv = Record<string, never>>(
  opts: KitRequestContextOptions<TEnv> = {},
): RequestContext<TEnv> {
  const { url = "https://example.com/", requestInit, ...rest } = opts;
  const request = new Request(url, requestInit);
  return createRequestContext<TEnv>({
    ...rest,
    env: (rest.env ?? {}) as TEnv,
    variables: rest.variables ?? {},
    request,
    url: new URL(request.url),
  });
}
