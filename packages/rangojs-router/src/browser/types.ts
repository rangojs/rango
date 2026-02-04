import type { ReactNode, ComponentType } from "react";
import type { ResolvedSegment, SlotState } from "../types.js";
import type { ResolvedThemeConfig, Theme } from "../theme/types.js";
import type { RenderSegmentsOptions } from "../segment-system.js";

// ============================================================================
// RSC Payload Types
// ============================================================================

/**
 * RSC payload received from server
 */
export interface RscPayload<TMetadata = RscMetadata> {
  root: ReactNode | Promise<ReactNode> | null;
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
  isPartial?: boolean;
  isError?: boolean;
  matched?: string[];
  diff?: string[];
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
   * Theme configuration from router.
   * Included when theme is enabled in router config.
   */
  themeConfig?: ResolvedThemeConfig | null;
  /**
   * Initial theme from cookie (for SSR hydration).
   * Included when theme is enabled in router config.
   */
  initialTheme?: Theme;
  /**
   * Route map for useHref() - maps route names to URL patterns.
   * Used for type-safe URL generation on the client.
   */
  routeMap?: Record<string, string>;
  /**
   * Current matched route name (for local name resolution in useHref).
   * When using include() with name prefix, this contains the full prefixed name.
   */
  routeName?: string;
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

  /** Current location (updated optimistically) */
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
 * Compatible with both Map and LRUCache
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
}

/**
 * State value for navigate/Link
 * - LocationStateEntry[]: Type-safe state entries (recommended)
 * - unknown: Legacy format for backwards compatibility
 */
export type HistoryState = import("./react/location-state-shared.js").LocationStateEntry[] | unknown;

/**
 * Options for navigation operations
 */
export interface NavigateOptions {
  replace?: boolean;
  scroll?: boolean;
  /**
   * State to pass to history.pushState/replaceState
   * Accessible via useLocationState() hook.
   *
   * @example
   * ```tsx
   * // Type-safe state (recommended)
   * const ProductState = createLocationState<{ name: string }>("product");
   * navigate("/product/123", { state: [ProductState({ name: "Widget" })] });
   *
   * // Multiple states
   * navigate("/checkout", { state: [ProductState(p), CartState(c)] });
   *
   * // Legacy format (backwards compatible)
   * navigate("/product", { state: { from: "list" } });
   * ```
   */
  state?: HistoryState;
}

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
    options?: { temporaryReferences?: any }
  ) => Promise<T>;
  createFromReadableStream: <T>(stream: ReadableStream) => Promise<T>;
  encodeReply: (
    args: any[],
    options?: { temporaryReferences?: any }
  ) => Promise<FormData | string>;
  setServerCallback: (
    callback: (id: string, args: any[]) => Promise<any>
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
    handleData?: HandleData
  ): void;
  getCachedSegments(
    historyKey: string
  ): { segments: ResolvedSegment[]; stale: boolean; handleData?: HandleData } | undefined;
  hasHistoryCache(historyKey: string): boolean;
  updateCacheHandleData(historyKey: string, handleData: HandleData): void;
  markCacheAsStale(): void;
  markCacheAsStaleAndBroadcast(): void;
  clearHistoryCache(): void;
  broadcastCacheInvalidation(): void;

  // Cross-tab refresh callback (set by navigation bridge)
  setCrossTabRefreshCallback(callback: () => void): void;

  // Intercept context tracking (for action revalidation)
  getInterceptSourceUrl(): string | null;
  setInterceptSourceUrl(url: string | null): void;

  // UI update notifications
  onUpdate(callback: UpdateSubscriber): () => void;
  emitUpdate(update: NavigationUpdate): void;

  // Action state tracking (for useAction hook)
  getActionState(actionId: string): TrackedActionState;
  setActionState(actionId: string, state: Partial<TrackedActionState>): void;
  subscribeToAction(
    actionId: string,
    listener: ActionStateListener
  ): () => void;
}

// ============================================================================
// Request Controller Types
// ============================================================================

/**
 * Disposable abort controller with automatic cleanup
 */
export interface DisposableAbortController extends Disposable {
  controller: AbortController;
}

/**
 * Request controller for managing concurrent requests
 *
 * Separates navigation requests (aborted on new navigation) from
 * action requests (complete independently of navigation).
 */
export interface RequestController {
  create(): AbortController;
  createDisposable(): DisposableAbortController;
  /** Create a disposable controller for actions (not aborted by navigation) */
  createActionDisposable(): DisposableAbortController;
  /** Abort all navigation requests (not actions) */
  abortAll(): void;
  /** Abort all action requests (used for error handling) */
  abortAllActions(): void;
  remove(controller: AbortController): void;
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
  unregister(): void;
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
    options?: RenderSegmentsOptions
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
    options?: RenderSegmentsOptions
  ) => Promise<ReactNode> | ReactNode;
}

// Re-export ResolvedSegment for convenience
export type { ResolvedSegment };
