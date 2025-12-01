import type { ReactNode } from "react";
import type { ResolvedSegment } from "../types.js";
import type { RenderSegmentsOptions } from "../segment-system.js";

// ============================================================================
// RSC Payload Types
// ============================================================================

/**
 * RSC payload received from server
 */
export interface RscPayload<TMetadata = RscMetadata> {
  root: ReactNode;
  metadata?: TMetadata;
  returnValue?: ActionResult;
  formState?: unknown;
}

/**
 * Metadata included in RSC responses
 */
export interface RscMetadata {
  pathname: string;
  segments: ResolvedSegment[];
  isPartial?: boolean;
  matched?: string[];
  diff?: string[];
}

/**
 * Result from server action execution
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
 * Navigation state exposed via useNavigation hook
 */
export interface NavigationState {
  /** Navigation lifecycle state (idle or loading during navigation) */
  state: "idle" | "loading";

  /** Whether RSC data is currently streaming (initial load or navigation) */
  isStreaming: boolean;

  /** Current location (updated optimistically) */
  location: NavigationLocation;

  /** Form submission state (filled during navigation-based form submit) */
  formData: FormData | null;
  formAction: string | null;

  /** List of inflight server actions */
  inflightActions: InflightAction[];
}

/**
 * Cache interface for storing segments
 * Compatible with both Map and LRUCache
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
 */
export interface SegmentState {
  path: string;
  currentUrl: string;
  currentSegmentIds: string[];
}

/**
 * Navigation update emitted when UI should re-render
 */
export interface NavigationUpdate {
  root: ReactNode;
  metadata: RscMetadata;
}

/**
 * Options for navigation operations
 */
export interface NavigateOptions {
  replace?: boolean;
  scroll?: boolean;
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
  cacheSegmentsForHistory(historyKey: string, segments: ResolvedSegment[]): void;
  getCachedSegments(historyKey: string): ResolvedSegment[] | undefined;
  hasHistoryCache(historyKey: string): boolean;
  clearHistoryCache(): void;

  // UI update notifications
  onUpdate(callback: UpdateSubscriber): () => void;
  emitUpdate(update: NavigationUpdate): void;
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
 */
export interface RequestController {
  create(): AbortController;
  createDisposable(): DisposableAbortController;
  abortAll(): void;
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
  requestController: RequestController;
  deps: RscBrowserDependencies;
  onUpdate: UpdateSubscriber;
  renderSegments: (segments: ResolvedSegment[], options?: RenderSegmentsOptions) => Promise<ReactNode> | ReactNode;
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
  requestController: RequestController;
  onUpdate: UpdateSubscriber;
  renderSegments: (segments: ResolvedSegment[], options?: RenderSegmentsOptions) => Promise<ReactNode> | ReactNode;
}

// Re-export ResolvedSegment for convenience
export type { ResolvedSegment };
