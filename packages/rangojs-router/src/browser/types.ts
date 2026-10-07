import type { ReactNode, ComponentType } from "react";
import type { ResolvedSegment, SlotState } from "../types.js";
import type { ResolvedThemeConfig, Theme } from "../theme/types.js";
import type { RenderSegmentsOptions } from "../segment-system.js";

// ============================================================================
// RSC Payload Types
// ============================================================================

/**
 * RSC payload received from server.
 * The tree is reconstructed from metadata.segments by the browser bridges.
 */
export interface RscPayload<TMetadata = RscMetadata> {
  metadata?: TMetadata;
  returnValue?: ActionResult;
}

/**
 * Handle data structure: handleName -> segmentId -> entries[]
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type HandleData = Record<string, Record<string, unknown[]>>;

/**
 * Metadata included in RSC responses
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface RscMetadata {
  pathname: string;
  segments: ResolvedSegment[];
  /** Router instance ID — the current app's identity. A mismatch with the
   *  client's id (sent as _rsc_rid) is detected server-side and answered with
   *  X-RSC-Reload (full document load), so the client never swaps apps
   *  in-session; within a session this always equals the current app. */
  routerId?: string;
  isPartial?: boolean;
  isError?: boolean;
  matched?: string[];
  diff?: string[];
  /**
   * All segment ids re-resolved on the server, including null-component
   * ones excluded from `segments`/`diff`. Drives client-side handle-bucket
   * cleanup. Superset of `diff`. See MatchResult.resolvedIds.
   */
  resolvedIds?: string[];
  /** Merged route params from the matched route */
  params?: Record<string, string>;
  /**
   * The matched route's name (include name prefix applied), when the route is
   * named. The browser keeps it per history entry for transition({ when })'s
   * `from.routeName` / `to.routeName` (browser/transition-when.ts).
   */
  routeName?: string;
  /**
   * State of named slots for this route match
   * Key is slot name (e.g., "@modal"), value is slot state
   * Slots are used for intercepting routes during soft navigation
   */
  slots?: Record<string, SlotState>;
  /**
   * Intercept TARGET route names reachable from this location as a
   * navigation origin. The browser-local clientUrls matcher declines its
   * optimistic presentation for these targets (the canonical response would
   * commit the intercept over the ORIGIN page, so destination loading would
   * flash and revert). Missing/empty means no targets.
   */
  interceptTargets?: string[];
  /** Root layout component for browser-side re-renders */
  rootLayout?: ComponentType<{ children: ReactNode }>;
  /** Handle data accumulated across route segments (async generator that yields on each push) */
  handles?: AsyncGenerator<HandleData, void, unknown>;
  /**
   * Document-lane late handle channel: pushes landing after the handler
   * barrier (streaming loader ctx.use(Handle) writes). Consumed non-blocking
   * post-hydration (rsc-router.tsx); `handles` above is drained in blocking
   * positions and must complete at the handler barrier.
   */
  handlesLate?: AsyncGenerator<HandleData, void, unknown>;
  /** Cached handle data (for back/forward navigation from cache) */
  cachedHandleData?: HandleData;
  /**
   * RSC version string from the server.
   * Used to detect version mismatches after HMR/deployment.
   */
  version?: string;
  /** Cloudflare dev worker generation used for stale-document convergence. */
  devDiscoveryEpoch?: number;
  /**
   * TTL in milliseconds for the client-side in-memory prefetch cache.
   * Sent on initial render so the browser can configure its cache duration.
   */
  prefetchCacheTTL?: number;
  /**
   * Max entries in the client-side in-memory prefetch cache (FIFO eviction).
   * Sent on initial render so the browser can configure its cache capacity.
   */
  prefetchCacheSize?: number;
  /**
   * Max concurrent speculative prefetch requests on the client.
   * Sent on initial render so the browser can configure its prefetch queue.
   */
  prefetchConcurrency?: number;
  /**
   * Router-wide default prefetch strategy for Links without a `prefetch` prop.
   * Sent on initial render; applied once at init (default-strategy.ts).
   */
  defaultPrefetch?: import("../router/prefetch-default.js").PrefetchStrategy;
  /**
   * Server-resolved rango state cookie name (`{prefix}_{routerId}`). The client
   * reads it verbatim and binds the rango state cookie to it; composition
   * happens only server-side.
   */
  stateCookieName?: string;
  /**
   * Theme configuration from router.
   * Included when theme is enabled in router config.
   */
  themeConfig?: ResolvedThemeConfig | null;
  /**
   * Initial theme from cookie (for SSR hydration).
   * Included when theme is enabled in router config.
   */
  initialTheme?: Theme;
  /** URL prefix for all routes (from createRouter({ basename })). */
  basename?: string;
  /** Whether connection warmup is enabled */
  warmupEnabled?: boolean;
  /**
   * Whether the client should hydrate inside React.StrictMode. Carried on the
   * initial full-render payload only; the browser entry reads it once at
   * hydration. Defaults to true on the client when omitted.
   */
  strictMode?: boolean;
  /**
   * Server-side redirect with optional state (for partial requests).
   * `external: true` (from redirect(url, { external: true })) tells the client
   * to hard-navigate to an off-host target instead of validating same-origin.
   */
  redirect?: { url: string; external?: boolean };
  /** Server-set location state to include in history.pushState */
  locationState?: Record<string, unknown>;
}

/**
 * Result from server action execution
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface ActionResult {
  ok: boolean;
  data: unknown;
}

// ============================================================================
// Navigation State Types
// ============================================================================

/**
 * Location object representing current URL
 * Uses URL for full URL parsing (origin, host, hostname, port, protocol, searchParams, etc.)
 */
export type NavigationLocation = URL;

/**
 * Inflight server action being tracked
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface InflightAction {
  /** Unique identifier for this action invocation */
  id: string;
  /** Server action function ID */
  actionId: string;
  /** Action arguments */
  payload: unknown[];
  /** Timestamp when action started */
  startedAt: number;
}

/**
 * Internal navigation state (includes inflight actions for store use)
 *
 * @internal This type is an implementation detail. Use PublicNavigationState instead.
 */
export interface NavigationState {
  /** Navigation lifecycle state (idle or loading during navigation) */
  state: "idle" | "loading";

  /** Whether RSC data is currently streaming (initial load or navigation) */
  isStreaming: boolean;

  /** Current location */
  location: NavigationLocation;

  /** URL being navigated to (null when idle) */
  pendingUrl: string | null;

  /** List of inflight server actions (internal use only) */
  inflightActions: InflightAction[];
}

/**
 * Public navigation state exposed via useNavigation hook
 * Excludes internal properties like inflightActions
 */
export type PublicNavigationState = Omit<NavigationState, "inflightActions">;

// ============================================================================
// Action State Types (for useAction hook)
// ============================================================================

/**
 * Action lifecycle state
 */
export type ActionLifecycleState = "idle" | "loading" | "streaming";

/**
 * State for a tracked server action
 * Used by useAction hook to observe action lifecycle
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface TrackedActionState {
  /** Current lifecycle state of the action */
  state: ActionLifecycleState;

  /** Server action function ID (e.g., "addToCart") */
  actionId: string | null;

  /** Action arguments (array for JSON, FormData for form submissions) */
  payload: unknown[] | FormData | null;

  /** Error if action failed */
  error: unknown | null;

  /** Result data from the action (preserved after completion) */
  result: unknown | null;
}

/**
 * The value returned by {@link useAction} when called without a selector.
 *
 * This is the stable, public name for the action-state shape; consumers can
 * name it in their own signatures (e.g. a wrapper hook). It aliases the
 * internal {@link TrackedActionState}.
 */
export type ActionState = TrackedActionState;

/**
 * Listener for action state changes
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type ActionStateListener = (state: TrackedActionState) => void;

/**
 * Cache interface for storing segments
 * Compatible with Map
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface SegmentCache {
  get(key: string): ResolvedSegment | undefined;
  set(key: string, value: ResolvedSegment): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  keys(): IterableIterator<string>;
  readonly size: number;
}

/**
 * Internal segment state managed by the store
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface SegmentState {
  path: string;
  currentUrl: string;
  currentSegmentIds: string[];
}

/**
 * What the router remembers about one history entry for transition({ when })
 * (NavigationStore.rememberDisplayedEntry).
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface HistoryEntryMemory {
  readonly routeName: string | undefined;
  /** The entry's `history.state` as last recorded. */
  readonly state: unknown;
}

/**
 * Navigation update emitted when UI should re-render
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface NavigationUpdate {
  root: ReactNode | Promise<ReactNode>;
  metadata: RscMetadata;
  /** Scroll behavior to apply after React commits this update */
  scroll?: {
    /** For back/forward: restore saved position */
    restore?: boolean;
    /** Set to false to disable scrolling entirely */
    enabled?: boolean;
    /** Function to check if streaming is in progress */
    isStreaming?: () => boolean;
  };
}

/**
 * Plain object accepted as {@link PlainHistoryState}. The `any` string index
 * admits interface-typed values (an `unknown` index would reject interfaces,
 * which carry no implicit index signature). The `never` members reject:
 * - a single typed entry (`GridState(value)` without the array) — its
 *   `__rsc_ls_*` fields would be spread onto history.state and
 *   `useLocationState(GridState)` would read `undefined`;
 * - functions, including a location-state definition passed uncalled
 *   (`Symbol.hasInstance` comes from `Function.prototype`), which throw
 *   `DataCloneError`;
 * - arrays and other iterables (`Symbol.iterator`), so an array must match the
 *   typed-entry or plain-array member instead;
 * - built-ins tagged with `Symbol.toStringTag` (`Promise`, `WeakMap`,
 *   `WeakSet`), which throw `DataCloneError`. The cloneable tagged ones
 *   (`Map`, `Set`, `ArrayBuffer`, typed arrays) have their own members.
 *
 * Members are not checked: a function, symbol, or React element inside a
 * plain object still compiles, as does a top-level `ReactElement` or DOM node
 * (an object with none of the keys above).
 */
export interface PlainHistoryObject {
  readonly [key: string]: any;
  readonly __rsc_ls_key?: never;
  readonly __rsc_ls_value?: never;
  readonly __rsc_ls_lazy?: never;
  readonly [Symbol.iterator]?: never;
  readonly [Symbol.hasInstance]?: never;
  readonly [Symbol.toStringTag]?: never;
}

/**
 * Plain (untyped) navigation state, stored under `history.state.state` and
 * read with `useLocationState<T>()`. A structured-clone-safe value: primitives,
 * arrays, `Map`/`Set`, `ArrayBuffer`, typed arrays, and plain objects. Excludes
 * functions, symbols, `Promise`/`WeakMap`/`WeakSet`, and objects carrying
 * `__rsc_ls_*` keys (a typed entry passed without its array). Arrays, `Map`,
 * and `Set` are checked element by element; plain object members are not
 * checked (see {@link PlainHistoryObject}).
 */
export type PlainHistoryState =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | readonly PlainHistoryState[]
  | ReadonlyMap<PlainHistoryState, PlainHistoryState>
  | ReadonlySet<PlainHistoryState>
  | ArrayBuffer
  | ArrayBufferView
  | PlainHistoryObject;

/**
 * State value for `router.push()` / `router.replace()` / `<Link state>`.
 * - `readonly LocationStateEntry[]`: typed entries from `createLocationState()`
 *   definitions, e.g. `[GridState({ count: 3 })]` (recommended)
 * - {@link PlainHistoryState}: plain structured-clone-safe state
 */
export type HistoryState =
  | readonly import("./react/location-state-shared.js").LocationStateEntry[]
  | PlainHistoryState;

/**
 * Options for navigation operations
 */
export interface NavigateOptions {
  replace?: boolean;
  scroll?: boolean;
  /**
   * Whether to revalidate server data on navigation.
   * Set to `false` to skip the RSC server fetch and only update the URL.
   *
   * Only takes effect when the pathname stays the same (search param / hash changes).
   * If the pathname changes, this option is ignored and a full navigation occurs.
   *
   * All location-aware hooks (`useSearchParams`, `useNavigation`, etc.) still update.
   * Server components do not re-render.
   *
   * @default true
   *
   * @example
   * ```tsx
   * router.push("/products?color=blue", { revalidate: false });
   * router.replace("/products?page=3", { revalidate: false });
   * ```
   */
  revalidate?: boolean;
  /**
   * Set to `false` to present this navigation without a transition: the
   * commit is urgent and every `<ViewTransition>` class resolves to `"none"`,
   * the same result as a `transition({ when })` predicate returning `false`.
   * No `when` predicate is called. Back/forward, action and revalidation
   * commits are unaffected (they are not started by this call).
   *
   * @default true (the route's transition config applies)
   *
   * @example
   * ```tsx
   * router.push("/photos/2", { transition: false });
   * <Link to="/photos/2" transition={false}>Next</Link>
   * ```
   */
  transition?: boolean;
  /**
   * State to pass to history.pushState/replaceState
   * Accessible via useLocationState() hook.
   *
   * @example
   * ```tsx
   * // Type-safe state (recommended)
   * const ProductState = createLocationState<{ name: string }>();
   * navigate("/product/123", { state: [ProductState({ name: "Widget" })] });
   *
   * // Type-safe just-in-time state (getter called at navigation time)
   * navigate("/product/123", {
   *   state: [ProductState(() => ({ name: computeName() }))],
   * });
   *
   * // Multiple states
   * navigate("/checkout", { state: [ProductState(p), CartState(c)] });
   *
   * // Plain static state
   * navigate("/product", { state: { from: "list" } });
   *
   * // Compile errors (and a dev-mode runtime error for untyped callers):
   * navigate("/product", { state: ProductState(p) }); // entry without the array
   * navigate("/product", { state: [ProductState] }); // definition not called
   * ```
   */
  state?: HistoryState;
}

/**
 * @internal Extended options used only within the navigation bridge. `state`
 * is widened to `unknown`: the redirect lanes pass state already resolved to
 * a flat `history.state` record, and in dev Link passes an uncalled
 * definition through to resolveNavigationState's check.
 */
export interface NavigateOptionsInternal extends Omit<
  NavigateOptions,
  "state"
> {
  state?: unknown;
  /** Skip segment cache (used by redirect-with-state to force re-render) */
  _skipCache?: boolean;
  /** Server redirects already followed by this navigation chain (0 for a user navigation) */
  _redirectHops?: number;
}

/**
 * Options for useRouter push/replace methods.
 * Same as NavigateOptions but without `replace` (implicit in push vs replace).
 */
export type RouterNavigateOptions = Omit<NavigateOptions, "replace">;

/**
 * Router instance returned by useRouter hook.
 * Provides stable action methods that never cause re-renders.
 */
export interface RouterInstance {
  /** Navigate to a URL, pushing a new entry to the history stack */
  push(url: string, options?: RouterNavigateOptions): Promise<void>;
  /** Navigate to a URL, replacing the current history entry */
  replace(url: string, options?: RouterNavigateOptions): Promise<void>;
  /** Refresh the current route (re-fetch server data, preserve client state) */
  refresh(): Promise<void>;
  /**
   * Prefetch a URL for faster client-side transition.
   *
   * Pass `{ key: ":source" }` to source-scope the prefetch cache entry (parity
   * with `<Link prefetchKey=":source">`) when the target's response can differ
   * by source page.
   */
  prefetch(url: string, options?: { key?: ":source" }): void;
  /** Go back in browser history */
  back(): void;
  /** Go forward in browser history */
  forward(): void;
}

/**
 * URLSearchParams without mutation methods.
 * Matches Next.js convention for useSearchParams return type.
 */
export type ReadonlyURLSearchParams = Omit<
  URLSearchParams,
  "append" | "delete" | "set" | "sort"
>;

// ============================================================================
// RSC Browser Dependencies
// ============================================================================

/**
 * RSC runtime functions from @vitejs/plugin-rsc/browser
 *
 * These are injected as dependencies to avoid direct coupling
 * to the RSC runtime implementation.
 */
export interface RscBrowserDependencies {
  createFromFetch: <T>(
    response: Promise<Response>,
    options?: {
      temporaryReferences?: any;
      findSourceMapURL?: (
        filename: string,
        environmentName: string,
      ) => string | null;
    },
  ) => Promise<T>;
  createFromReadableStream: <T>(stream: ReadableStream) => Promise<T>;
  encodeReply: (
    args: any[],
    options?: { temporaryReferences?: any },
  ) => Promise<FormData | string>;
  setServerCallback: (
    callback: (id: string, args: any[]) => Promise<any>,
  ) => void;
  createTemporaryReferenceSet: () => any;
}

// ============================================================================
// Store Types
// ============================================================================

/**
 * Update subscriber callback for UI updates
 */
export type UpdateSubscriber = (update: NavigationUpdate) => void;

/**
 * State change listener for useNavigation hook subscriptions
 */
export type StateListener = () => void;

/**
 * Navigation store interface
 *
 * Owns segment state, history snapshots, and partial-update notifications.
 * EventController owns the public navigation lifecycle exposed by hooks.
 */
export interface NavigationStore {
  // Internal segment state (for bridges)
  getSegmentState(): SegmentState;
  setPath(path: string): void;
  setCurrentUrl(url: string): void;
  setSegmentIds(ids: string[]): void;

  // History-based segment cache (for back/forward navigation and partial merging)
  getHistoryKey(): string;
  setHistoryKey(key: string): void;

  /**
   * Per-history-entry memory for transition({ when }) sources: record the
   * entry on screen (keyed by its `history.state.key`) with its current
   * `history.state` and, when given, its route name (kept from the last
   * record otherwise; every push/replace creates a new key, so a stale name
   * never carries to another entry). Called after every commit, restore and
   * state merge.
   */
  rememberDisplayedEntry(routeName?: string): void;
  /**
   * The memory of the entry on screen, or of `entryKey`. At popstate
   * history.state already belongs to the destination, so back/forward reads
   * the entry being LEFT from here. In-memory only: empty after a reload.
   */
  getHistoryEntryMemory(entryKey?: string): HistoryEntryMemory | undefined;
  /** Monotonic token of the most recently committed navigation. */
  getNavInstance(): number;
  cacheSegmentsForHistory(
    historyKey: string,
    segments: ResolvedSegment[],
    handleData?: HandleData,
  ): void;
  getCachedSegments(historyKey: string):
    | {
        segments: ResolvedSegment[];
        stale: boolean;
        handleData?: HandleData;
        routerId?: string;
        /**
         * True when the entry's handle data is incomplete (a deferred Meta was
         * still pending at navigate-away). A popstate return must revalidate with
         * a FULL re-render so the server re-streams handles.
         */
        handlesPending?: boolean;
      }
    | undefined;
  hasHistoryCache(historyKey: string): boolean;
  /**
   * Update only the handleData (and optionally the stale / handlesPending flags)
   * of an existing cache entry. When a flag is omitted the entry's current value
   * is preserved. `stale=true` marks a single entry stale so a popstate return
   * revalidates it; `handlesPending=true` additionally forces that revalidation
   * to be a full re-render (so a deferred Meta re-streams).
   */
  updateCacheHandleData(
    historyKey: string,
    handleData: HandleData,
    stale?: boolean,
    handlesPending?: boolean,
  ): void;
  /**
   * Owner-guarded variant of updateCacheHandleData: writes only when the entry
   * is still owned by `ownerInstance`. Folds the caller's separate ownership
   * probe and write into one historyCache scan for the per-yield streaming path.
   */
  updateCacheHandleDataIfOwned(
    historyKey: string,
    handleData: HandleData,
    ownerInstance: number,
    stale?: boolean,
    handlesPending?: boolean,
  ): void;
  markHistoryCacheStale(): void;
  markCacheAsStaleAndBroadcast(): void;
  clearHistoryCache(): void;

  // Cross-tab refresh callback (set by navigation bridge)
  setCrossTabRefreshCallback(callback: () => void): void;

  // Intercept context tracking (for action revalidation)
  getInterceptSourceUrl(): string | null;
  setInterceptSourceUrl(url: string | null): void;

  // Router identity tracking (for cross-app navigation detection)
  getRouterId?(): string | undefined;
  setRouterId?(id: string): void;

  // UI update notifications
  onUpdate(callback: UpdateSubscriber): () => void;
  emitUpdate(update: NavigationUpdate): void;
}

// ============================================================================
// Navigation Client Types
// ============================================================================

/**
 * Options for partial navigation fetch
 */
export interface FetchPartialOptions {
  targetUrl: string;
  segmentIds: string[];
  previousUrl: string;
  signal?: AbortSignal;
  /** If true, this is a stale cache revalidation request - server should force revalidators */
  staleRevalidation?: boolean;
  /**
   * Encoded client-run per-loader revalidation decisions
   * (clientUrls revalidate() predicates executed in the browser); sent as
   * X-Rango-Client-Reval and honored only by materialized client-urls loader
   * stubs. Null/absent = locked server defaults.
   */
  clientRevalidation?: string | null;
  interceptSourceUrl?: string;
  /** RSC version for cache invalidation detection */
  version?: string;
  /** Current router ID — server detects app switch and returns full response */
  routerId?: string;
  /** If true, this is an HMR refetch - server should invalidate manifest cache */
  hmr?: boolean;
  /**
   * The fill request of an adopted prefetch that carried deferred segments
   * (`prefetch: false`): marked `_rsc_fill`, never answered from or written
   * to a prefetch cache or the HTTP cache, and it cancels no prefetch.
   */
  fill?: boolean;
}

/**
 * Result of a partial fetch including stream completion tracking
 */
export interface FetchPartialResult {
  payload: RscPayload;
  /** Promise that resolves when the response stream is fully consumed */
  streamComplete: Promise<void>;
  /**
   * True only when this payload came from a prefetch-cache hit whose stream had
   * ALREADY fully drained at fetch time (the route was fully prefetched). The
   * commit then runs in a startTransition so loading()/Suspense content — already
   * resolved — swaps in directly without flashing a fallback. A partially-warmed
   * (still-streaming) prefetch hit and a cold fetch leave this false so their
   * fallbacks stream as usual.
   */
  fullyPrefetched?: boolean;
}

/**
 * Navigation client for fetching RSC payloads
 */
export interface NavigationClient {
  fetchPartial(options: FetchPartialOptions): Promise<FetchPartialResult>;
}

// ============================================================================
// Link Interceptor Types
// ============================================================================

/**
 * Options for link interception
 */
export interface LinkInterceptorOptions {
  shouldIntercept?: (link: HTMLAnchorElement) => boolean;
}

// ============================================================================
// Server Action Bridge Types
// ============================================================================

/**
 * Server action bridge for handling server actions
 */
export interface ServerActionBridge {
  register(): void;
}

/**
 * Configuration for server action bridge
 */
export interface ServerActionBridgeConfig {
  store: NavigationStore;
  client: NavigationClient;
  deps: RscBrowserDependencies;
  onUpdate: UpdateSubscriber;
  renderSegments: (
    segments: ResolvedSegment[],
    options?: RenderSegmentsOptions,
  ) => Promise<ReactNode> | ReactNode;
}

// ============================================================================
// Navigation Bridge Types
// ============================================================================

/**
 * Navigation bridge for handling client-side navigation
 */
export interface NavigationBridge {
  navigate(url: string, options?: NavigateOptionsInternal): Promise<void>;
  refresh(): Promise<void>;
  handlePopstate(): Promise<void>;
  registerLinkInterception(): () => void;
  registerDelegatedPrefetch(): () => void;
  /** Current RSC version (live, reflects the latest updateVersion). */
  getVersion(): string | undefined;
  /** Update the RSC version (e.g. after HMR). Clears prefetch cache. */
  updateVersion(newVersion: string): void;
}

/**
 * Configuration for navigation bridge
 */
export interface NavigationBridgeConfig {
  store: NavigationStore;
  client: NavigationClient;
  onUpdate: UpdateSubscriber;
  renderSegments: (
    segments: ResolvedSegment[],
    options?: RenderSegmentsOptions,
  ) => Promise<ReactNode> | ReactNode;
}

// Re-export ResolvedSegment for convenience
export type { ResolvedSegment };

/**
 * Token for tracking an active stream.
 * Call end() when the stream completes.
 */
export interface StreamingToken {
  end(): void;
}
