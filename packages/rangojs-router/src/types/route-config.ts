import type { ReactNode } from "react";

/**
 * Props for the Document component that wraps the entire application.
 */
export type DocumentProps = {
  children: ReactNode;
};

/**
 * @deprecated RouterEnv is no longer needed. Pass bindings directly as TEnv
 * to createRouter<TEnv>() and declare RSCRouter.Vars for variables.
 *
 * Migration:
 *   // Before:
 *   type AppEnv = RouterEnv<AppBindings, AppVariables>;
 *   createRouter<AppEnv>();
 *
 *   // After:
 *   createRouter<AppBindings>();
 *   declare global { namespace RSCRouter { interface Vars extends AppVariables {} } }
 */
export interface RouterEnv<TBindings = {}, TVariables = {}> {
  Bindings: TBindings;
  Variables: TVariables;
}

/**
 * Parse constraint values into a union type
 * "a|b|c" -> "a" | "b" | "c"
 */
type ParseConstraint<T extends string> =
  T extends `${infer First}|${infer Rest}` ? First | ParseConstraint<Rest> : T;

/**
 * Extract param info from a param segment
 *
 * Handles:
 * - :param -> { name: "param", optional: false, type: string }
 * - :param? -> { name: "param", optional: true, type: string }
 * - :param(a|b) -> { name: "param", optional: false, type: "a" | "b" }
 * - :param(a|b)? -> { name: "param", optional: true, type: "a" | "b" }
 */
type ExtractParamInfo<T extends string> =
  // Optional + constrained: :param(a|b)?
  T extends `${infer Name}(${infer Constraint})?`
    ? { name: Name; optional: true; type: ParseConstraint<Constraint> }
    : // Constrained only: :param(a|b)
      T extends `${infer Name}(${infer Constraint})`
      ? { name: Name; optional: false; type: ParseConstraint<Constraint> }
      : // Optional only: :param?
        T extends `${infer Name}?`
        ? { name: Name; optional: true; type: string }
        : // Required: :param
          { name: T; optional: false; type: string };

/**
 * Build param object from info
 */
type ParamFromInfo<Info> = Info extends {
  name: infer N extends string;
  optional: true;
  type: infer V;
}
  ? { [K in N]?: V }
  : Info extends {
        name: infer N extends string;
        optional: false;
        type: infer V;
      }
    ? { [K in N]: V }
    : never;

/**
 * Merge two param objects preserving optionality
 * Uses Pick to preserve the modifiers from source types
 */
type MergeParams<A, B> = Pick<A, keyof A> & Pick<B, keyof B> extends infer O
  ? { [K in keyof O]: O[K] }
  : never;

/**
 * Extract route params from a pattern with depth limit to prevent infinite recursion
 *
 * Supports:
 * - Required params: /:slug -> { slug: string }
 * - Optional params: /:locale? -> { locale?: string }
 * - Constrained params: /:locale(en|gb) -> { locale: "en" | "gb" }
 * - Optional + constrained: /:locale(en|gb)? -> { locale?: "en" | "gb" }
 *
 * @example
 * ExtractParams<"/products/:id"> // { id: string }
 * ExtractParams<"/:locale?/blog/:slug"> // { locale?: string; slug: string }
 * ExtractParams<"/:locale(en|gb)/blog"> // { locale: "en" | "gb" }
 * ExtractParams<"/:locale(en|gb)?/blog/:slug"> // { locale?: "en" | "gb"; slug: string }
 */
export type ExtractParams<
  T extends string,
  Depth extends readonly unknown[] = [],
> = Depth["length"] extends 10
  ? { [key: string]: string | undefined } // Fallback to generic params if too deep
  : // Match param with remaining path: :param.../rest
    T extends `${infer _Start}:${infer Param}/${infer Rest}`
    ? MergeParams<
        ParamFromInfo<ExtractParamInfo<Param>>,
        ExtractParams<`/${Rest}`, readonly [...Depth, unknown]>
      >
    : // Match param at end: :param...
      T extends `${infer _Start}:${infer Param}`
      ? ParamFromInfo<ExtractParamInfo<Param>>
      : {};

/**
 * Trailing slash handling mode
 * - "never": Redirect URLs with trailing slash to without
 * - "always": Redirect URLs without trailing slash to with
 * - "ignore": Match both with and without trailing slash
 */
export type TrailingSlashMode = "never" | "always" | "ignore";

/**
 * Route configuration object (alternative to string path)
 */
export type RouteConfig = {
  path: string;
  trailingSlash?: TrailingSlashMode;
};

/**
 * Route definition options (global defaults)
 */
export type RouteDefinitionOptions = {
  trailingSlash?: TrailingSlashMode;
};

export type RouteDefinition = {
  [key: string]: string | RouteConfig | RouteDefinition;
};

/**
 * Recursively flatten nested routes with depth limit to prevent infinite recursion
 * Transforms: { products: { detail: "/product/:slug" } } => { "products.detail": "/product/:slug" }
 * Also handles RouteConfig objects: { api: { path: "/api" } } => { "api": "/api" }
 */
type FlattenRoutes<
  T extends RouteDefinition,
  Prefix extends string = "",
  Depth extends readonly unknown[] = [],
> = Depth["length"] extends 5
  ? never
  : {
      [K in keyof T]: T[K] extends string
        ? Record<`${Prefix}${K & string}`, T[K]>
        : T[K] extends RouteConfig
          ? Record<`${Prefix}${K & string}`, T[K]["path"]>
          : T[K] extends RouteDefinition
            ? FlattenRoutes<
                T[K],
                `${Prefix}${K & string}.`,
                readonly [...Depth, unknown]
              >
            : never;
    }[keyof T];

/**
 * Union to intersection helper
 */
type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

/**
 * Resolved route map - flattened route definitions with full paths
 */
export type ResolvedRouteMap<T extends RouteDefinition> = UnionToIntersection<
  FlattenRoutes<T>
>;
