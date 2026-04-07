import type { ContextVar } from "../context-var.js";
import type { ReverseFunction } from "../reverse.js";
import type {
  DefaultReverseRouteMap,
  DefaultVars,
} from "../types/global-namespace.js";
import type { UseItems, ResponseRouteUseItem } from "../route-types.js";

/**
 * Reverse function for response handler contexts.
 * Global names get autocomplete and param validation from the generated route map.
 * Local `.name` calls are accepted but not validated (scope unknown at type level).
 */
type ResponseReverseFunction = [DefaultReverseRouteMap] extends [
  Record<string, string>,
]
  ? (
      name: string,
      params?: Record<string, string>,
      search?: Record<string, unknown>,
    ) => string
  : ReverseFunction<DefaultReverseRouteMap> & {
      (
        name: `.${string}`,
        params?: Record<string, string>,
        search?: Record<string, unknown>,
      ): string;
    };

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
export type ResponseHandler<TParams = Record<string, string>, TEnv = any> = ((
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => Response | Promise<Response>) & {
  /** Composable default DSL items merged when the handler is mounted. */
  use?: () => UseItems<ResponseRouteUseItem>;
};

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
> = ((
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => JsonValue | Response | Promise<JsonValue | Response>) & {
  /** Composable default DSL items merged when the handler is mounted. */
  use?: () => UseItems<ResponseRouteUseItem>;
};

/**
 * Handler for text-based response routes (text, html, xml).
 * Can return a string (auto-wrapped) or Response (pass-through).
 */
export type TextResponseHandler<
  TParams = Record<string, string>,
  TEnv = any,
> = ((
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => string | Response | Promise<string | Response>) & {
  /** Composable default DSL items merged when the handler is mounted. */
  use?: () => UseItems<ResponseRouteUseItem>;
};

/**
 * Lighter handler context for response routes.
 * No ctx.use() (no loaders). Supports setting response headers via ctx.header().
 * Use the standalone cookies() function for cookie mutations.
 */
export interface ResponseHandlerContext<
  TParams = Record<string, string>,
  TEnv = any,
> {
  request: Request;
  params: TParams;
  /** @internal Phantom property for params type invariance. Prevents mounting handlers on wrong routes. */
  readonly _paramCheck?: (params: TParams) => TParams;
  /** Platform bindings (DB, KV, secrets, etc.). */
  env: TEnv;
  /** Query parameters from the URL (system params like `_rsc*` are filtered). */
  searchParams: URLSearchParams;
  /** The full URL object (with system params filtered). */
  url: URL;
  /** The pathname portion of the request URL. */
  pathname: string;
  reverse: ResponseReverseFunction;
  /** Read a variable set by middleware via ctx.set(key, value) or ctx.set(ContextVar, value). */
  get: {
    <T>(contextVar: ContextVar<T>): T | undefined;
  } & (<K extends keyof DefaultVars>(key: K) => DefaultVars[K]);
  /** Set a response header. Merged into the auto-wrapped or pass-through Response. */
  header: (name: string, value: string) => void;
}
