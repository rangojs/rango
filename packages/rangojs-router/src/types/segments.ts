import type { ReactNode } from "react";
import type { ErrorInfo, NotFoundInfo } from "./boundaries.js";
import type { IsActionFn } from "./handler-context.js";
import type { DefaultRouteName } from "./global-namespace.js";

/**
 * CSS class(es) for a ViewTransition phase.
 * Can be a simple string or an object mapping transition types to class names
 * for direction-aware transitions (e.g., { "navigation": "slide-right", "navigation-back": "slide-left" }).
 */
export type ViewTransitionClass = Record<string, string> | string;

/**
 * One side of a navigation as the browser knows it when a
 * `transition({ when })` predicate runs.
 */
export interface RouteLocation {
  readonly url: URL;
  /** Merged route params of the location. */
  readonly params: Readonly<Record<string, string>>;
  /**
   * The matched route's name (include prefixes applied), typed from the
   * generated route map; undefined for an unnamed route or when unknown.
   * Internal names never appear here.
   */
  readonly routeName: DefaultRouteName | undefined;
  /**
   * `history.state` of this entry at decision time. Read a typed slot with
   * `Def.read(location)` (a `createLocationState()` definition).
   */
  readonly state: unknown;
}

/**
 * A navigation side as the server sees it, for intercept's `when` selector:
 * a {@link RouteLocation} without `state` (history state never reaches the
 * server).
 */
export type ServerRouteLocation = Omit<RouteLocation, "state">;

/**
 * How the navigation being decided was started.
 *
 * - `"push"` / `"replace"`: a Link click, `router.push()` / `router.replace()`
 *   or `navigate()`.
 * - `"pop"`: browser back/forward (restored from the history cache or
 *   refetched).
 * - `"action"`: the commit that applies a server action's revalidation,
 *   including the error-boundary commit of a failed action.
 * - `"revalidate"`: a re-render of the current URL: `router.refresh()`,
 *   cross-tab invalidation, or the background revalidation of a stale entry.
 */
export type TransitionWhenKind =
  | "push"
  | "replace"
  | "pop"
  | "action"
  | "revalidate";

/**
 * The context a `transition({ when })` predicate receives. The predicate runs
 * in the BROWSER, once per navigation, at the first commit that presents the
 * destination. The server never calls it.
 *
 * - `from`: the committed location being left.
 * - `to`: the destination. The same object as `from` for `"action"` and
 *   `"revalidate"`.
 * - `isAction`: the matcher `revalidate()` predicates get; `false` off an
 *   action.
 * - `action`: present only for `kind: "action"`.
 */
export interface TransitionWhenContext {
  readonly kind: TransitionWhenKind;
  readonly from: RouteLocation;
  readonly to: RouteLocation;
  readonly isAction: IsActionFn;
  /** Present only for `kind: "action"`. */
  readonly action?: {
    /** The action's hashed `$$id` in the browser; match with `isAction(fn)` instead. */
    readonly id: string | undefined;
    /** The FormData argument the action received (the 2nd argument under `useActionState`). */
    readonly formData: FormData | undefined;
    /** The action's return value on success. */
    readonly result: unknown;
    /** What a failed action threw (its error-boundary commit); `result` is undefined then. */
    readonly error: unknown;
  };
}

/**
 * Browser-run predicate that gates whether a navigation holds and animates.
 *
 * In `urls()` write it inline (`transition({ when: (ctx) => ... })`, which
 * the build hoists into a client module; it may reference only its own
 * bindings, globals and client-safe imports) or export it from a
 * `"use client"` module and import it; in `clientUrls()` it is an inline
 * function. Anything else (a server function, a non-function) fails route
 * discovery.
 *
 * `false` makes the navigation an urgent commit: no hold, no view transition,
 * and a same-route navigation streams its `loading()` fallback. The segment
 * keeps its key and its `<ViewTransition>` element (every class "none"), so
 * nothing remounts. One predicate returning false decides for the whole
 * navigation. A throw is logged with `console.error` and counts as `false`.
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
   * Optional browser-run predicate that gates this transition per
   * navigation. See {@link TransitionWhenFn}.
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
  /**
   * True when this loader was awaited before first flush
   * (loader(Def, { ssr: false })). Stamped by resolveLoaders (fresh.ts) on
   * document AND shell-capture renders — capture bakes flagged loaders and
   * awaits the same lane. Feeds segment-system's settled-value delivery and
   * the dev SSR suspension warning (ssr-suspension-warning.ts).
   */
  awaitBeforeFlush?: true;
  parallelLoading?: ReactNode; // For parallel-owned loaders: the parallel's loading fallback
  // Intercept loader fields (for streaming loader data in parallel segments)
  loaderDataPromise?: Promise<any[]> | any[]; // Loader data promise or resolved array
  loaderIds?: string[]; // IDs ($$id) of loaders for this segment
  /**
   * Per-loader UNDECODED results for a layout/route stream map.
   * Flagged (ssr:false) entries are settled values; unflagged siblings
   * stay promises. Parallel slots do not use this channel — they pin
   * loading() / live-lane holes via use(loaderDataPromise).
   */
  loaderStreams?: Record<string, unknown>;
  /** $$ids of loaders this segment awaited before flush. Dev diagnostic. */
  awaitedLoaderIds?: string[];
  // Error-specific fields
  error?: ErrorInfo; // For error segments: the error information
  // NotFound-specific fields
  notFoundInfo?: NotFoundInfo; // For notFound segments: the not found information
  // Mount path from include() scope, used for MountContext.Provider wrapping
  mountPath?: string;
  /** clientUrls() group key (the include mount), shared by every route
   *  segment of one group; see the group-route branch in segment-system.tsx. */
  clientGroup?: string;
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
   * Intercept TARGET route names reachable when this location is a navigation
   * origin (chain walk of the matched entry, when-conditionals included).
   * Shipped in payload metadata so the browser-local clientUrls matcher can
   * decline its optimistic presentation for targets an intercept would claim.
   */
  interceptTargets?: string[];
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
