import type { ReactNode } from "react";
import type { ErrorInfo, NotFoundInfo } from "./boundaries.js";
import type { RevalidateParams, HandlerContext } from "./handler-context.js";

/**
 * CSS class(es) for a ViewTransition phase.
 * Can be a simple string or an object mapping transition types to class names
 * for direction-aware transitions (e.g., { "navigation": "slide-right", "navigation-back": "slide-left" }).
 */
export type ViewTransitionClass = Record<string, string> | string;

/**
 * The context a transition({ when }) predicate receives.
 *
 * It mirrors the {@link ShouldRevalidateFn} args a `revalidate()` predicate
 * gets — the same navigation/action metadata — so the two read the same shape,
 * plus `get`/`env` for post-handler reads. There is no full `HandlerContext`
 * here: the gate runs at the RSC-payload layer with the request context, not a
 * handler context, so handler-only sugar (`search`/`build`/`dev`/`headers`) is
 * absent by design. `get` is the way to read what the handler/middleware set
 * via `ctx.set(...)` this request.
 *
 * Field availability (all source fields are optional — never fabricated):
 * - `currentUrl` / `currentParams` / `fromRouteName` (the navigation SOURCE) are
 *   populated on soft navigations and action-success revalidations. They are
 *   undefined on an initial full document load and on action-error / no-JS error
 *   paths that skip the navigation snapshot — there is no prior page to name.
 * - `nextUrl` / `nextParams` / `get` / `env` / `method` are always present;
 *   `toRouteName` is present only when the target route is named (undefined for
 *   unnamed/auto-generated routes, like `fromRouteName`).
 * - `actionId` / `actionUrl` / `actionResult` / `formData` are populated only
 *   when a server action triggered the render; `method` is "POST" then, "GET"
 *   otherwise. On no-JS (progressive-enhancement) error or form-parse-failure
 *   paths an action was attempted — so `actionUrl` (and possibly `formData`) is
 *   present — but `actionId` may be undefined because the failing action's id
 *   could not be resolved. Treat `actionId` as "the action, if known", not as
 *   "was this an action".
 *
 * PREFETCH / CACHE CAVEAT (read this before gating on the source): the gate runs
 * server-side during resolution. A PREFETCHED navigation renders at prefetch
 * time, so `currentUrl`/`currentParams`/`fromRouteName` reflect the page the
 * prefetch fired from, NOT necessarily the page the user actually navigates from
 * — the decision is baked into the stored Flight payload and replayed verbatim.
 * A `cache()`/prerender hit replays the stored transition with the predicate NOT
 * re-run at all. So a source-sensitive predicate can be frozen to prefetch-time
 * or store-time state. This is accepted (~99% of navigations match), but if your
 * gate must reflect the exact click-time source, source-scope the prefetch
 * (`<Link prefetchKey=":source">`) and do not `cache()` that segment.
 */
export type TransitionWhenContext<
  TParams = Record<string, string>,
  TEnv = unknown,
> = Partial<
  Pick<
    RevalidateParams<TParams, TEnv>,
    "currentUrl" | "currentParams" | "fromRouteName"
  >
> &
  Pick<
    RevalidateParams<TParams, TEnv>,
    | "nextUrl"
    | "nextParams"
    | "toRouteName"
    | "actionId"
    | "actionUrl"
    | "actionResult"
    | "formData"
    | "method"
  > &
  Pick<HandlerContext<any, TEnv>, "get" | "env">;

/**
 * Predicate that gates whether a transition() applies for the current request.
 *
 * Evaluated server-side AFTER the route's handler runs (so `get(...)` can read
 * handler/middleware-set state) and outside any cache scope. Return false to
 * drop this segment's transition for the request; return true to apply it. The
 * context ({@link TransitionWhenContext}) carries the same navigation/action
 * metadata a `revalidate()` predicate sees plus `get`/`env`. If it throws, the
 * error is reported to the router's onError (phase "rendering") and the
 * transition is dropped (the navigation does not hold).
 *
 * Distinct from intercept()'s `when` config selector, which runs at MATCH time
 * over `{ from, to, params, segments, … }`; a transition `when` runs
 * post-handler over the resolved payload.
 *
 * Scope: dropping a transition removes only THIS segment's contribution to the
 * navigation's hold. The startTransition hold is navigation-wide — it engages if
 * any matched segment still has a transition — so `when: false` makes the
 * navigation stream its loading fallback only when no other matched segment
 * keeps a transition (the common case: a single transition on the route).
 *
 * Evaluated on every fresh (cache-miss) resolution; it is NOT re-run when a
 * segment is replayed from the runtime cache or a build-time prerender, and a
 * prefetched navigation freezes it to prefetch-time state — see the caveat on
 * {@link TransitionWhenContext}.
 */
export type TransitionWhenFn = (ctx: TransitionWhenContext) => boolean;

/**
 * Configuration for React's <ViewTransition> component.
 *
 * The phase fields (enter/exit/update/share/default/name) map directly to
 * ViewTransitionProps (minus children/ref/callbacks). The `viewTransition`
 * field is router-specific and is stripped before the config reaches React.
 */
export interface TransitionConfig {
  enter?: ViewTransitionClass;
  exit?: ViewTransitionClass;
  update?: ViewTransitionClass;
  share?: ViewTransitionClass;
  default?: ViewTransitionClass;
  name?: string;
  /**
   * Whether the router wraps this segment's content in its own
   * <ViewTransition> boundary.
   *
   * - "auto" (default): the router places the boundary, producing the
   *   router-owned cross-fade described by the phase fields above.
   * - false: the router places no boundary. The navigation commit is still
   *   driven through startTransition (so loaders hold instead of flashing a
   *   skeleton, and consumer-placed <ViewTransition> elements still animate),
   *   but the router contributes no cross-fade of its own.
   *
   * When unset, inherits the createRouter({ viewTransition }) default.
   */
  viewTransition?: "auto" | false;
  /**
   * Optional server-side predicate that gates this transition per request. When
   * present and it returns false (evaluated post-handler), the router drops this
   * segment's transition for the request, so the navigation streams its loading
   * fallback instead of holding. The predicate is server-only and never
   * serialized to the client; only its resolved effect (transition kept or
   * dropped) crosses. See {@link TransitionWhenFn}.
   */
  when?: TransitionWhenFn;
}

/**
 * Resolved segment with component
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface ResolvedSegment {
  id: string;
  namespace: string; // Optional namespace for segment (used for parallel groups)
  type: "layout" | "route" | "parallel" | "loader" | "error" | "notFound";
  index: number;
  component: ReactNode; // Component, handler promise, or resolved element
  loading?: ReactNode; // Loading component for this segment (shown during navigation)
  transition?: TransitionConfig; // ViewTransition config for this segment
  layout?: ReactNode; // Layout element to wrap content (used by intercept segments)
  params?: Record<string, string>;
  slot?: string; // For parallel segments: '@sidebar', '@modal', etc.
  belongsToRoute?: boolean; // True if segment belongs to the matched route (route itself + its children)
  layoutName?: string; // For layouts: the layout name identifier
  parallelName?: string; // For parallels: the parallel group name (used to match with revalidations)
  // Loader-specific fields
  loaderId?: string; // For loaders: the loader $$id identifier
  _inherited?: boolean; // For inherited loaders: dedup marker for buildMatchResult
  loaderData?: any; // For loaders: the resolved data from loader execution
  parallelLoading?: ReactNode; // For parallel-owned loaders: the parallel's loading fallback
  // Intercept loader fields (for streaming loader data in parallel segments)
  loaderDataPromise?: Promise<any[]> | any[]; // Loader data promise or resolved array
  loaderIds?: string[]; // IDs ($$id) of loaders for this segment
  // Error-specific fields
  error?: ErrorInfo; // For error segments: the error information
  // NotFound-specific fields
  notFoundInfo?: NotFoundInfo; // For notFound segments: the not found information
  // Mount path from include() scope, used for MountContext.Provider wrapping
  mountPath?: string;
  /**
   * @internal Server-side marker: true when the segment's handler actually ran
   * this request (not skipped via the revalidate cache path). Used by
   * match-result.ts to populate `MatchResult.resolvedIds` for client-side
   * handle-bucket cleanup. Stripped from the wire payload before serialization
   * — never reaches the client.
   */
  _handlerRan?: boolean;
}

export interface SegmentMetadata {
  id: string;
  type: "layout" | "route" | "parallel" | "loader" | "error" | "notFound";
  index: number;
  params?: Record<string, string>;
  slot?: string;
  loaderId?: string;
  error?: ErrorInfo;
  notFoundInfo?: NotFoundInfo;
}

// Note: route symbols are now defined in route-definition.ts
// as properties on the route() function

/**
 * State of a named slot (e.g., @modal, @sidebar)
 * Used for intercepting routes where slots render alternative content
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface SlotState {
  /**
   * Whether the slot is currently active (has content to render)
   */
  active: boolean;
  /**
   * Segments for this slot when active
   */
  segments?: ResolvedSegment[];
}

/**
 * Props passed to the root layout component
 */
export interface RootLayoutProps {
  children: ReactNode;
}

/**
 * Router match result
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface MatchResult {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
  /**
   * Every segment id whose handler actually ran on the server this request,
   * including ones with `component === null` that get filtered out of
   * `segments`/`diff` to avoid wasted bytes. Drives the client's handle-
   * cleanup pass — a slot that re-resolves and pushes nothing must clear
   * its previous handle bucket, but `diff` doesn't carry it because the
   * segment payload doesn't either. A superset of `diff`.
   */
  resolvedIds: string[];
  /**
   * Merged route params from all matched segments
   * Available for use by the handler after route matching
   */
  params: Record<string, string>;
  /**
   * The matched route name (includes name prefix from include()).
   * Used by ctx.reverse() for local name resolution.
   */
  routeName?: string;
  /**
   * State of named slots for this route match
   * Key is slot name (e.g., "@modal"), value is slot state
   * Slots are used for intercepting routes during soft navigation
   */
  slots?: Record<string, SlotState>;
  /**
   * Redirect URL for trailing slash normalization.
   * When set, the RSC handler should return a 308 redirect to this URL
   * instead of rendering the page.
   */
  redirect?: string;
  /**
   * Route-level middleware collected from the matched entry tree.
   * These run with the same onion-style execution as app-level middleware,
   * wrapping the entire RSC response creation.
   */
  routeMiddleware?: Array<{
    handler: import("../router/middleware.js").MiddlewareFn;
    params: Record<string, string>;
  }>;
}
