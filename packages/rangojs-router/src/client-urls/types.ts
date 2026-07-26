import type { ComponentType, ReactNode } from "react";
import type {
  LoaderDefinition,
  LoaderOptions,
  TransitionConfig,
} from "../types.js";
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

/**
 * Arguments a clientUrls() revalidate() predicate receives. A client-computable
 * subset of the server ShouldRevalidateFn args — the predicate RUNS IN THE
 * BROWSER (it is declared in a "use client" module and never crosses the
 * projection boundary); only its decision is sent to the server. There is no
 * `context` — no server handler context exists where this executes.
 */
export interface ClientRevalidateArgs {
  /** Full URL of the page being navigated away from (current location). */
  readonly currentUrl: URL;
  /** Full URL of the navigation target (equals currentUrl for actions). */
  readonly nextUrl: URL;
  /** Route params of the held client route (definition-local match). */
  readonly currentParams: Record<string, string>;
  /** Route params for the navigation target (definition-local match). */
  readonly nextParams: Record<string, string>;
  /**
   * The locked default decision for this loader, computed client-side with
   * the same rules the server would apply: `true` on actions and when
   * params/search changed, `false` otherwise. Return it for default behavior
   * plus your own conditions.
   */
  readonly defaultShouldRevalidate: boolean;
  /** True when this is a stale history-entry background revalidation. */
  readonly stale: boolean;
  /** True when revalidation is triggered by a server action. */
  readonly isAction: boolean;
  /** The triggering server action's id, when isAction. */
  readonly actionId?: string;
}

export type ClientRevalidateFn = (args: ClientRevalidateArgs) => boolean;

export interface ClientUrlLoaderRecord {
  readonly loader: LoaderDefinition<any, any>;
  /** Client-run per-loader revalidation predicates; empty = locked defaults. */
  readonly revalidate: readonly ClientRevalidateFn[];
  /**
   * loader(Def, { stream: "navigation" }): document renders await this loader
   * before first flush (see {@link LoaderOptions}). Projected into the server
   * tree, where the per-isSSR entry stamping applies — client navigations
   * stream regardless.
   */
  readonly stream?: "navigation";
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
  /**
   * Attach a projected loader. The optional use callback may contain
   * revalidate() only — a CLIENT-RUN per-loader predicate; its decision (not
   * the function) is sent with the revalidation request.
   *
   * Pass `{ stream: "navigation" }` to await this loader before first flush
   * on DOCUMENT requests (see {@link LoaderOptions}) — the opt-in for loaders
   * whose data, handle pushes, or thrown notFound()/redirect() must be in the
   * SSR'd HTML. Per-loader: a dynamic sibling keeps streaming.
   */
  readonly loader: <TData>(
    definition: LoaderDefinition<TData>,
    optionsOrUse?: LoaderOptions | ClientUrlUse,
    use?: ClientUrlUse,
  ) => ClientUrlItem;
  readonly loading: (component: ReactNode) => ClientUrlItem;
  /**
   * Per-loader revalidation predicate, valid inside a loader() use callback
   * only. Runs IN THE BROWSER with client-computable args; return true to
   * re-run the loader, false to keep held data. Absent predicates (and
   * requests that carry no decisions: no-JS, PE, prefetch, document loads)
   * follow the locked server defaults.
   */
  readonly revalidate: (fn: ClientRevalidateFn) => ClientUrlItem;
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
