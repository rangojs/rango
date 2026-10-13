import type { ComponentType, ReactNode } from "react";
import type {
  LoaderDefinition,
  LoaderOptions,
  ShouldRevalidateFn,
  TransitionConfig,
} from "../types.js";
import type { DefaultEnv } from "../types/global-namespace.js";
import type { HoistedRevalidateRef } from "./hoisted-revalidate.js";
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
> = Pick<
  PathOptions<TName, TSearch>,
  "name" | "search" | "trailingSlash" | "ppr"
>;

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
  /**
   * Per-loader revalidate() predicates, run on the server; empty = the
   * router's defaults. Under the rango Vite plugin the browser and SSR copies
   * hold the marker the build left in place of each hoisted predicate; a
   * boolean literal stays in place.
   */
  readonly revalidate: readonly (
    | ShouldRevalidateFn<any, DefaultEnv>
    | HoistedRevalidateRef
    | boolean
  )[];
  /**
   * loader(Def, { ssr: false }): document renders await this loader before
   * first flush (see {@link LoaderOptions}). Projected into the server tree,
   * where the per-isSSR entry stamping applies — client navigations stream
   * regardless.
   */
  readonly ssr?: false;
  /**
   * loader(Def, { prefetch: false }): a prefetch of the route, or of an
   * intercept's target from its source, defers this loader and the click
   * that adopts it runs it in its fill request (see {@link LoaderOptions}).
   * Projected onto the materialized stub.
   */
  readonly prefetch?: false;
}

/**
 * The TransitionConfig subset a clientUrls() route may declare: ViewTransition
 * classes/name, the boundary opt-out, and the browser-run `when` gate. The
 * projection carries only a "has when" marker; the browser calls the function
 * this module declares (transition-when-ref.ts resolveTransitionWhen).
 */
export type ClientTransitionConfig = Pick<
  TransitionConfig,
  | "enter"
  | "exit"
  | "update"
  | "share"
  | "default"
  | "name"
  | "viewTransition"
  | "when"
>;

export interface ClientUrlRouteRecord {
  readonly id: string;
  readonly pattern: string;
  readonly name: string | undefined;
  readonly options: Readonly<ClientPathOptions> | undefined;
  readonly component: ComponentType;
  readonly layouts: readonly ComponentType[];
  /**
   * One per entry in `layouts`: the layout() item's ordinal among its sibling
   * layout()s, its React key. Routes under the same layout() share it, so
   * ClientUrlsRoot keeps that layout's instance across them (#1124). Keys only
   * need to be unique among siblings: a differing parent layout remounts the
   * whole subtree anyway.
   */
  readonly layoutKeys: readonly number[];
  readonly loaders: readonly ClientUrlLoaderRecord[];
  /**
   * The leading `loaders` its layout()s declare, the same record objects for
   * every route under a layout (flattenLayout creates them once): ClientUrlsRoot
   * keeps a shared one's committed data in the optimistic frame.
   */
  readonly layoutLoaders: readonly ClientUrlLoaderRecord[];
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
  /**
   * Attach a projected loader. The optional use callback may contain
   * revalidate() only: a per-loader predicate the server runs, as in urls().
   *
   * Pass `{ ssr: false }` — the same knob as loading(fallback, { ssr:
   * false }) — to await this loader before first flush on DOCUMENT requests
   * (see {@link LoaderOptions}): the opt-in for loaders whose data, handle
   * pushes, or thrown notFound()/redirect() must be in the SSR'd HTML.
   * Per-loader: a streaming sibling keeps streaming. Under a `ppr` group
   * route the flag BAKES: the loader executes at shell capture and its
   * settled return freezes into the shell (nested promises stay live
   * holes).
   *
   * Pass `{ prefetch: false }` to keep this loader out of the route's
   * prefetches (see {@link LoaderOptions}): an in-group click still shows
   * the destination at once, commits the adopted prefetch with the other
   * loaders' data, and runs only the flagged loaders in its one fill
   * request. A `layout()` loader with the flag is flagged on every route
   * below it. Inside intercept() it defers the loader in a prefetch of the
   * intercept from its source, as in urls().
   */
  readonly loader: <TData>(
    definition: LoaderDefinition<TData>,
    optionsOrUse?: Pick<LoaderOptions, "ssr" | "prefetch"> | ClientUrlUse,
    use?: ClientUrlUse,
  ) => ClientUrlItem;
  readonly loading: (component: ReactNode) => ClientUrlItem;
  /**
   * Per-loader revalidation predicate, valid inside a loader() use callback
   * only. It runs ON THE SERVER with the same arguments as a urls() loader's
   * revalidate() (`actionResult`, `formData`, `context`, `isAction`, route
   * names, ...): the build moves it out of this "use client" module. It may
   * reference imports and globals only; a binding of this module, `this`,
   * `import()`, a browser global, an `async` function or an import from a
   * "use client" module fails the build with its file and line. A boolean
   * is shorthand for `() => true` / `() => false`.
   */
  readonly revalidate: (
    fn: ShouldRevalidateFn<any, DefaultEnv> | boolean,
  ) => ClientUrlItem;
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
