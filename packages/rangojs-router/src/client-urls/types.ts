import type { ComponentType, ReactNode } from "react";
import type { LoaderDefinition } from "../types.js";
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

export interface ClientUrlRouteRecord {
  readonly id: string;
  readonly pattern: string;
  readonly name: string | undefined;
  readonly options: Readonly<ClientPathOptions> | undefined;
  readonly component: ComponentType;
  readonly layouts: readonly ComponentType[];
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
}

export type ClientUrlBuilder<TItems extends ClientUrlItems = ClientUrlItems> = (
  helpers: ClientUrlHelpers,
) => TItems;

export interface ClientUrlPatterns<
  TRoutes extends Record<string, any> = Record<string, any>,
> {
  readonly __brand: "client-urls";
  readonly routes: readonly ClientUrlRouteRecord[];
  readonly [CLIENT_URL_PATTERNS_BRAND]: void;
  readonly _routes?: TRoutes;
  match(pathname: string): TrieMatchResult | null;
}
