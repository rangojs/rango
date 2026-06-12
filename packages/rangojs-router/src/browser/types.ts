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
  formState?: unknown;
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
   * State of named slots for this route match
   * Key is slot name (e.g., "@modal"), value is slot state
   * Slots are used for intercepting routes during soft navigation
   */
  slots?: Record<string, SlotState>;
  /** Root layout component for browser-side re-renders */
  rootLayout?: ComponentType<{ children: ReactNode }>;
  /** Handle data accumulated across route segments (async generator that yields on each push) */
  handles?: AsyncGenerator<HandleData, void, unknown>;
  /** Cached handle data (for back/forward navigation from cache) */
  cachedHandleData?: HandleData;
  /**
   * RSC version string from the server.
   * Used to detect version mismatches after HMR/deployment.
   */
  version?: string;
  /**
   * TTL in milliseconds for the client-side in-memory prefetch cache.
   * Sent on initial render so the browser can configure its cache duration.
   */
  prefetchCacheTTL?: number;
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
  /** Server-side redirect with optional state (for partial requests) */
  redirect?: { url: string };
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
 * State value for navigate/Link
 * - LocationStateEntry[]: Type-safe state entries (recommended)
 * - unknown: Plain state format (object or getter function)
 */
export type HistoryState =
  | import("./react/location-state-shared.js").LocationStateEntry[]
  | unknown;

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
   * // Plain just-in-time state
   * navigate("/product", { state: () => ({ from: window.location.pathname }) });
   * ```
   */
  state?: HistoryState;
}

/** @internal Extended options used only within the navigation bridge */
export interface NavigateOptionsInternal extends NavigateOptions {
  /** Skip segment cache (used by redirect-with-state to force re-render) */
  _skipCache?: boolean;
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
  /** Prefetch a URL for faster client-side transition */
  prefetch(url: string): void;
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
 * Manages both:
 * - NavigationState: Public state exposed via useNavigation hook
 * - SegmentState: Internal segment management for partial updates
 */
export interface NavigationStore {
  // Public state (for useNavigation hook)
  getState(): NavigationState;
  setState(partial: Partial<NavigationState>): void;
  subscribe(listener: StateListener): () => void;

  // Inflight action management
  addInflightAction(action: InflightAction): void;
  removeInflightAction(id: string): void;

  // Action state (for controlling update behavior during server actions)
  isActionInProgress(): boolean;
  setActionInProgress(value: boolean): void;

  // Internal segment state (for bridges)
  getSegmentState(): SegmentState;
  setPath(path: string): void;
  setCurrentUrl(url: string): void;
  setSegmentIds(ids: string[]): void;

  // History-based segment cache (for back/forward navigation and partial merging)
  getHistoryKey(): string;
  setHistoryKey(key: string): void;
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
      }
    | undefined;
  hasHistoryCache(historyKey: string): boolean;
  updateCacheHandleData(historyKey: string, handleData: HandleData): void;
  markCacheAsStale(): void;
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

  // Action state tracking (for useAction hook)
  getActionState(actionId: string): TrackedActionState;
  setActionState(actionId: string, state: Partial<TrackedActionState>): void;
  subscribeToAction(
    actionId: string,
    listener: ActionStateListener,
  ): () => void;
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
  interceptSourceUrl?: string;
  /** RSC version for cache invalidation detection */
  version?: string;
  /** Current router ID — server detects app switch and returns full response */
  routerId?: string;
  /** If true, this is an HMR refetch - server should invalidate manifest cache */
  hmr?: boolean;
}

/**
 * Result of a partial fetch including stream completion tracking
 */
export interface FetchPartialResult {
  payload: RscPayload;
  /** Promise that resolves when the response stream is fully consumed */
  streamComplete: Promise<void>;
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
  navigate(url: string, options?: NavigateOptions): Promise<void>;
  refresh(): Promise<void>;
  handlePopstate(): Promise<void>;
  registerLinkInterception(): () => void;
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
