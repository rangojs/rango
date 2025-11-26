import type { ReactNode } from "react";
import type { ResolvedSegment } from "../types.js";

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
 */
export interface NavigationLocation {
  pathname: string;
  search: string;
  hash: string;
  href: string;
}

/**
 * Navigation state exposed via useNavigation hook
 */
export interface NavigationState {
  /** Navigation lifecycle state */
  state: "idle" | "loading" | "submitting";

  /** Current location (updated optimistically) */
  location: NavigationLocation;

  /** Form submission state (filled during submit) */
  formData: FormData | null;
  formAction: string | null;

  /** Server action state (filled during action) */
  actionId: string | null;
  actionPayload: unknown[] | null;
  actionData: unknown | null;
}

/**
 * Internal segment state managed by the store
 */
export interface SegmentState {
  path: string;
  currentUrl: string;
  currentSegmentIds: string[];
  storedSegments: Map<string, ResolvedSegment>;
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

  // Internal segment state (for bridges)
  getSegmentState(): SegmentState;
  setPath(path: string): void;
  setCurrentUrl(url: string): void;
  setSegmentIds(ids: string[]): void;
  storeSegment(segment: ResolvedSegment): void;
  storeSegments(segments: ResolvedSegment[]): void;

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
 * Navigation client for fetching RSC payloads
 */
export interface NavigationClient {
  fetchPartial(options: FetchPartialOptions): Promise<RscPayload>;
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
  renderSegments: (segments: ResolvedSegment[]) => ReactNode;
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
  handlePopstate(): void;
  registerLinkInterception(): () => void;
  onPendingChange(callback: (isPending: boolean) => void): () => void;
}

/**
 * Configuration for navigation bridge
 */
export interface NavigationBridgeConfig {
  store: NavigationStore;
  client: NavigationClient;
  requestController: RequestController;
  onUpdate: UpdateSubscriber;
  renderSegments: (segments: ResolvedSegment[]) => ReactNode;
}

// Re-export ResolvedSegment for convenience
export type { ResolvedSegment };
