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
  /** Name prefix for all routes in this pattern set */
  name?: TNamePrefix;
}
