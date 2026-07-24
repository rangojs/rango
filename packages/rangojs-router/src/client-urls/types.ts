import type { ComponentType, ReactNode } from "react";
import type { LoaderDefinition, TransitionConfig } from "../types.js";
import type { TrieMatchResult } from "../router/trie-matching.js";
import type { PathOptions } from "../urls/pattern-types.js";
import type { SearchSchema } from "../search-params.js";
import type { TypedLayoutItem, TypedRouteItem } from "../route-types.js";
import type { ExtractRoutes } from "../urls/type-extraction.js";
import type { UnnamedRoute } from "../urls/pattern-types.js";

declare const CLIENT_URL_ITEM_BRAND: unique symbol;
declare const CLIENT_URL_PATTERNS_BRAND: unique symbol;

/** Opaque value returned by a clientUrls() helper. */
export interface ClientUrlItem {
  readonly [CLIENT_URL_ITEM_BRAND]: void;
}

export type ClientUrlItemInput = ClientUrlItem | readonly ClientUrlItemInput[];

export type ClientUrlItems = readonly ClientUrlItemInput[];

export type ClientUrlUse = () => ClientUrlItems;

export type ClientPathOptions<
  TName extends string = string,
  TSearch extends SearchSchema = SearchSchema,
> = Pick<PathOptions<TName, TSearch>, "name" | "search" | "trailingSlash">;

export type ClientPathFn = <
  const TPattern extends string,
  const TName extends string = UnnamedRoute,
  const TSearch extends SearchSchema = {},
>(
  pattern: TPattern,
  component: ComponentType,
  optionsOrUse?: ClientPathOptions<TName, TSearch> | ClientUrlUse,
  use?: ClientUrlUse,
) => ClientUrlItem & TypedRouteItem<TName, TPattern, unknown, TSearch>;

export type ClientLayoutFn = <const TItems extends ClientUrlItems>(
  component: ComponentType,
  children: () => TItems,
) => ClientUrlItem & TypedLayoutItem<ExtractRoutes<TItems>>;

export interface ClientUrlLoaderRecord {
  readonly loader: LoaderDefinition<any, any>;
}

/**
 * The data-only subset of TransitionConfig a clientUrls() route may declare:
 * ViewTransition classes/name plus the boundary opt-out. The `when` gate is a
 * server-executed predicate and stays in the server tree — it cannot cross the
 * "use client" projection boundary.
 */
export type ClientTransitionConfig = Pick<
  TransitionConfig,
  "enter" | "exit" | "update" | "share" | "default" | "name" | "viewTransition"
>;

export interface ClientUrlRouteRecord {
  readonly id: string;
  readonly pattern: string;
  readonly name: string | undefined;
  readonly options: Readonly<ClientPathOptions> | undefined;
  readonly component: ComponentType;
  readonly layouts: readonly ComponentType[];
  readonly loaders: readonly ClientUrlLoaderRecord[];
  readonly loading: ReactNode | undefined;
  readonly transition: Readonly<ClientTransitionConfig> | undefined;
}

/**
 * A restricted intercept declared inside clientUrls(). Compared to the server
 * intercept() there is no `when` selector, no middleware, and the target must
 * be a dot-local NAMED route in the same definition — every field is
 * JSON-projectable, which is what makes the declaration legal in a
 * "use client" module. `targetName` is stored bare (no leading dot).
 */
export interface ClientUrlInterceptRecord {
  readonly slotName: `@${string}`;
  readonly targetName: string;
  readonly component: ComponentType;
  readonly loaders: readonly ClientUrlLoaderRecord[];
  readonly loading: ReactNode | undefined;
}

export interface ClientUrlHelpers {
  readonly path: ClientPathFn;
  readonly layout: ClientLayoutFn;
  readonly loader: <TData>(
    definition: LoaderDefinition<TData>,
  ) => ClientUrlItem;
  readonly loading: (component: ReactNode) => ClientUrlItem;
  /**
   * Declare an intercept for a named route in THIS definition. The target is
   * dot-local (`.detail`); scoping is module-local — only navigations whose
   * origin is inside this clientUrls() group render the intercept. `use` may
   * contain loader() and loading() only.
   */
  readonly intercept: (
    slotName: `@${string}`,
    targetName: `.${string}`,
    component: ComponentType,
    use?: ClientUrlUse,
  ) => ClientUrlItem;
  /**
   * Opt THIS route into transition-driven navigation: the canonical commit
   * holds previous content instead of re-streaming the loading() fallback,
   * and on experimental React the config's ViewTransition classes apply.
   * Data-only — no `when` gate (server-executed; declare it in the server
   * tree). Valid inside a path() use callback only.
   */
  readonly transition: (config: ClientTransitionConfig) => ClientUrlItem;
}

export type ClientUrlBuilder<TItems extends ClientUrlItems = ClientUrlItems> = (
  helpers: ClientUrlHelpers,
) => TItems;

export interface ClientUrlPatterns<
  TRoutes extends Record<string, any> = Record<string, any>,
> {
  readonly __brand: "client-urls";
  readonly routes: readonly ClientUrlRouteRecord[];
  readonly intercepts: readonly ClientUrlInterceptRecord[];
  readonly [CLIENT_URL_PATTERNS_BRAND]: void;
  readonly _routes?: TRoutes;
  match(pathname: string): TrieMatchResult | null;
}
