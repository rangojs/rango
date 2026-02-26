import type { RouterEnv } from "../types.js";
import type { CookieOptions } from "../router/middleware.js";
import type { ContextVar } from "../context-var.js";

/**
 * Symbol marking a route as a response route (non-RSC).
 * Stored on PathOptions and UrlPatterns to signal the trie to short-circuit.
 */
export const RESPONSE_TYPE: unique symbol = Symbol.for(
  "rangojs.responseType",
) as any;

/**
 * Handler that must return Response (not ReactNode).
 * Used by path.image(), path.stream(), path.any() (binary/streaming data).
 */
export type ResponseHandler<TParams = Record<string, string>, TEnv = any> = (
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => Response | Promise<Response>;

/**
 * JSON-serializable value type for auto-wrap support.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Handler for JSON response routes.
 * Can return a plain JSON-serializable value (auto-wrapped) or Response (pass-through).
 */
export type JsonResponseHandler<
  TParams = Record<string, string>,
  TEnv = any,
> = (
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => JsonValue | Response | Promise<JsonValue | Response>;

/**
 * Handler for text-based response routes (text, html, xml).
 * Can return a string (auto-wrapped) or Response (pass-through).
 */
export type TextResponseHandler<
  TParams = Record<string, string>,
  TEnv = any,
> = (
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => string | Response | Promise<string | Response>;

/**
 * Lighter handler context for response routes.
 * No ctx.use() (no loaders). Supports setting response headers and cookies
 * without constructing a full Response object.
 */
export interface ResponseHandlerContext<
  TParams = Record<string, string>,
  TEnv = any,
> {
  request: Request;
  params: TParams;
  /** @internal Phantom property for params type invariance. Prevents mounting handlers on wrong routes. */
  readonly _paramCheck?: (params: TParams) => TParams;
  /** Platform bindings (DB, KV, secrets, etc.) extracted from RouterEnv. */
  env: TEnv extends RouterEnv<infer B, any> ? B : {};
  /** Query parameters from the URL (system params like `_rsc*` are filtered). */
  searchParams: URLSearchParams;
  /** The full URL object (with system params filtered). */
  url: URL;
  /** The pathname portion of the request URL. */
  pathname: string;
  reverse: (name: string, params?: Record<string, string>) => string;
  /** Read a variable set by middleware via ctx.set(key, value) or ctx.set(ContextVar, value). */
  get: {
    <T>(contextVar: ContextVar<T>): T | undefined;
    (key: string): unknown;
  };
  /** Set a response header. Merged into the auto-wrapped or pass-through Response. */
  header: (name: string, value: string) => void;
  /** Set a cookie on the response. */
  setCookie: (name: string, value: string, options?: CookieOptions) => void;
}
