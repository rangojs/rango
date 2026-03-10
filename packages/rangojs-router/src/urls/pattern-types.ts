import type { ReactNode } from "react";
import type { Handler, TrailingSlashMode } from "../types.js";
import type {
  AllUseItems,
  RouteUseItem,
  UrlPatternsBrand,
} from "../route-types.js";
import type { SearchSchema } from "../search-params.js";
import { RESPONSE_TYPE } from "./response-types.js";

/**
 * Sentinel type for unnamed routes.
 * Using a branded string instead of `never` prevents TypeScript from
 * widening array type inference when mixing named and unnamed routes.
 */
export type UnnamedRoute = "$unnamed";

/**
 * Sentinel type for include() mounts that stay local to the mounted module.
 * This keeps child route names out of the parent/global type map while still
 * allowing the mounted module to use its own local route names internally.
 *
 * Branded with a symbol key so it cannot be accidentally produced by user code.
 */
declare const LOCAL_ONLY_BRAND: unique symbol;
export type LocalOnlyInclude = string & { [LOCAL_ONLY_BRAND]: void };

/**
 * Options for path() function
 */
export interface PathOptions<
  TName extends string = string,
  TSearch extends SearchSchema = {},
> {
  /** Route name for href() lookups */
  name?: TName;
  /** Search param schema for typed query parameters */
  search?: TSearch;
  /** Trailing slash behavior: "never" (redirect /path/ to /path), "always" (redirect /path to /path/), "ignore" (match both) */
  trailingSlash?: TrailingSlashMode;
  /** Response type marker (set by path.json(), etc.) */
  [RESPONSE_TYPE]?: string;
}

/**
 * Internal representation of a URL pattern definition
 */
export interface PathDefinition {
  pattern: string;
  name?: string;
  handler: ReactNode | Handler<any, any, any>;
  use?: RouteUseItem[];
}

/**
 * Result of urls() - contains the route definitions
 */
export interface UrlPatterns<
  TEnv = any,
  TRoutes extends Record<string, any> = Record<string, string>,
  TResponses extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Internal: route definitions */
  readonly definitions: PathDefinition[];
  /** Internal: compiled handler function */
  readonly handler: () => AllUseItems[];
  /** Internal: trailing slash config per route name */
  readonly trailingSlash: Record<string, TrailingSlashMode>;
  /** Brand for type checking */
  readonly [UrlPatternsBrand]: void;
  /** Environment type brand (phantom) */
  readonly _env?: TEnv;
  /** Routes type brand (phantom) - carries route name -> pattern mapping */
  readonly _routes?: TRoutes;
  /** Responses type brand (phantom) - carries route name -> response data type mapping */
  readonly _responses?: TResponses;
}

/**
 * Options for include()
 */
export interface IncludeOptions<TNamePrefix extends string = string> {
  /**
   * Name prefix for all routes in this pattern set.
   *
   * - `{ name: "blog" }` — children become `blog.index`, `blog.detail`, etc.
   *   Visible in generated route types and resolvable globally via `reverse("blog.index")`.
   * - `{ name: "" }` — children merge into the parent namespace with no prefix.
   *   Equivalent to defining the routes inline at the include site.
   * - Omitted — children live in a private local scope, hidden from the
   *   generated route map and global reverse resolution. Only dot-local
   *   reverse (e.g. `reverse(".child")`) works from inside the module.
   */
  name?: TNamePrefix;
}
