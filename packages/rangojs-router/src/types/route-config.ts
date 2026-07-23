import type { ReactNode } from "react";

/**
 * Props for the Document component that wraps the entire application.
 */
export type DocumentProps = {
  children: ReactNode;
};

type ParseConstraint<T extends string> =
  T extends `${infer First}|${infer Rest}` ? First | ParseConstraint<Rest> : T;

// Named catch-all (`:name*` / `:name+`) is matched BEFORE the `?`/suffix
// branches. Its modifier is anchored to the END of the token (no trailing
// `${string}`) so it is a true suffix and never mis-splits a constraint body
// such as `id(\d+)`. Both are a required `string`: a matched catch-all always
// binds a value (possibly ""), so the key is always present.
type ExtractParamInfo<T extends string> =
  T extends `${infer Name}(${infer Constraint})?${string}`
    ? { name: Name; optional: true; type: ParseConstraint<Constraint> }
    : T extends `${infer Name}(${infer Constraint})${string}`
      ? { name: Name; optional: false; type: ParseConstraint<Constraint> }
      : T extends `${infer Name}*`
        ? { name: Name; optional: false; type: string }
        : T extends `${infer Name}+`
          ? { name: Name; optional: false; type: string }
          : T extends `${infer Name}?${string}`
            ? { name: Name; optional: true; type: string }
            : T extends `${infer Name}.${string}`
              ? { name: Name; optional: false; type: string }
              : T extends `${infer Name}-${string}`
                ? { name: Name; optional: false; type: string }
                : T extends `${infer Name}~${string}`
                  ? { name: Name; optional: false; type: string }
                  : { name: T; optional: false; type: string };

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
 * - Named catch-all: /:path+ (one-or-more), /:slug* (zero-or-more) -> string
 *
 * @example
 * ExtractParams<"/products/:id"> // { id: string }
 * ExtractParams<"/:locale?/blog/:slug"> // { locale?: string; slug: string }
 * ExtractParams<"/:locale(en|gb)/blog"> // { locale: "en" | "gb" }
 * ExtractParams<"/:locale(en|gb)?/blog/:slug"> // { locale?: "en" | "gb"; slug: string }
 * ExtractParams<"/docs/:slug*"> // { slug: string }
 * ExtractParams<"/shop/:path+"> // { path: string }
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

export type RouteConfig = {
  path: string;
  trailingSlash?: TrailingSlashMode;
};

export type RouteDefinitionOptions = {
  trailingSlash?: TrailingSlashMode;
};

export type RouteDefinition = {
  [key: string]: string | RouteConfig | RouteDefinition;
};

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

type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

export type ResolvedRouteMap<T extends RouteDefinition> = UnionToIntersection<
  FlattenRoutes<T>
>;
