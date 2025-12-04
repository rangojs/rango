/**
 * Navigation Store Events
 *
 * Event-driven lifecycle for navigation and server actions.
 * Allows external systems to react to state transitions without coupling to store internals.
 */

// ============================================================================
// Event Types
// ============================================================================

/**
 * Global store lifecycle events
 */
export type GlobalEventType =
  | "hydrated"
  | "idle"
  | "error";

/**
 * Navigation lifecycle events
 */
export type NavigationEventType =
  | "navigation:start"
  | "navigation:loaded"
  | "navigation:streaming"
  | "navigation:idle"
  | "navigation:cancelled"
  | "navigation:error";

/**
 * Action lifecycle events
 */
export type ActionEventType =
  | "action:start"
  | "action:loaded"
  | "action:streaming"
  | "action:idle"
  | "action:cancelled"
  | "action:error";

/**
 * All store event types
 */
export type StoreEventType = GlobalEventType | NavigationEventType | ActionEventType;

// ============================================================================
// Global Events
// ============================================================================

/**
 * Emitted when the store has completed hydration
 */
export interface HydratedEvent {
  type: "hydrated";
  /** Initial URL at hydration */
  url: string;
  /** Time taken to hydrate in ms */
  duration: number;
}

/**
 * Emitted when all navigation and actions are complete and UI is flushed
 */
export interface IdleEvent {
  type: "idle";
  /** Current URL when idle was reached */
  url: string;
}

/**
 * Emitted when an error occurs
 */
export interface ErrorEvent {
  type: "error";
  /** Error that occurred */
  error: Error;
  /** Context where error occurred */
  context: "navigation" | "action" | "hydration" | "unknown";
  /** Associated URL if applicable */
  url?: string;
  /** Associated action ID if applicable */
  actionId?: string;
}

export type GlobalEvent = HydratedEvent | IdleEvent | ErrorEvent;

// ============================================================================
// Navigation Events
// ============================================================================

/**
 * Navigation event payloads
 */
export interface NavigationStartEvent {
  type: "navigation:start";
  /** URL navigating from */
  fromUrl: string;
  /** URL navigating to */
  toUrl: string;
  /** Whether this is a replace navigation */
  replace: boolean;
}

export interface NavigationLoadedEvent {
  type: "navigation:loaded";
  /** URL navigated from */
  fromUrl: string;
  /** URL navigated to */
  toUrl: string;
}

export interface NavigationStreamingEvent {
  type: "navigation:streaming";
  /** URL navigated from */
  fromUrl: string;
  /** URL navigating to */
  toUrl: string;
}

export interface NavigationIdleEvent {
  type: "navigation:idle";
  /** URL navigated from */
  fromUrl: string;
  /** URL navigated to (now current) */
  toUrl: string;
}

export interface NavigationCancelledEvent {
  type: "navigation:cancelled";
  /** URL navigated from */
  fromUrl: string;
  /** URL that was being navigated to */
  toUrl: string;
  /** Reason for cancellation */
  reason: "aborted" | "replaced";
}

export interface NavigationErrorEvent {
  type: "navigation:error";
  /** URL navigated from */
  fromUrl: string;
  /** URL that was being navigated to */
  toUrl: string;
  /** Error that occurred */
  error: Error;
}

export type NavigationEvent =
  | NavigationStartEvent
  | NavigationLoadedEvent
  | NavigationStreamingEvent
  | NavigationIdleEvent
  | NavigationCancelledEvent
  | NavigationErrorEvent;

// ============================================================================
// Action Events
// ============================================================================

/**
 * Action event payloads
 */
export interface ActionStartEvent {
  type: "action:start";
  /** Unique ID for this action invocation */
  id: string;
  /** Server action function ID */
  actionId: string;
  /** Action arguments */
  payload: unknown[];
  /** Current URL when action started */
  url: string;
}

export interface ActionLoadedEvent {
  type: "action:loaded";
  id: string;
  actionId: string;
  url: string;
}

export interface ActionStreamingEvent {
  type: "action:streaming";
  id: string;
  actionId: string;
  url: string;
}

export interface ActionIdleEvent {
  type: "action:idle";
  id: string;
  actionId: string;
  url: string;
  /** Action return value if any */
  result?: unknown;
}

export interface ActionCancelledEvent {
  type: "action:cancelled";
  id: string;
  actionId: string;
  url: string;
  reason: "aborted";
}

export interface ActionErrorEvent {
  type: "action:error";
  id: string;
  actionId: string;
  url: string;
  error: Error;
}

export type ActionEvent =
  | ActionStartEvent
  | ActionLoadedEvent
  | ActionStreamingEvent
  | ActionIdleEvent
  | ActionCancelledEvent
  | ActionErrorEvent;

/**
 * All store events
 */
export type StoreEvent = GlobalEvent | NavigationEvent | ActionEvent;

// ============================================================================
// Event Listener Types
// ============================================================================

/**
 * Event listener callback
 */
export type StoreEventListener<T extends StoreEvent = StoreEvent> = (
  event: T
) => void;

/**
 * Typed event listener map
 */
export type EventListenerMap = {
  // Global events
  hydrated: StoreEventListener<HydratedEvent>;
  idle: StoreEventListener<IdleEvent>;
  error: StoreEventListener<ErrorEvent>;
  // Navigation events
  "navigation:start": StoreEventListener<NavigationStartEvent>;
  "navigation:loaded": StoreEventListener<NavigationLoadedEvent>;
  "navigation:streaming": StoreEventListener<NavigationStreamingEvent>;
  "navigation:idle": StoreEventListener<NavigationIdleEvent>;
  "navigation:cancelled": StoreEventListener<NavigationCancelledEvent>;
  "navigation:error": StoreEventListener<NavigationErrorEvent>;
  // Action events
  "action:start": StoreEventListener<ActionStartEvent>;
  "action:loaded": StoreEventListener<ActionLoadedEvent>;
  "action:streaming": StoreEventListener<ActionStreamingEvent>;
  "action:idle": StoreEventListener<ActionIdleEvent>;
  "action:cancelled": StoreEventListener<ActionCancelledEvent>;
  "action:error": StoreEventListener<ActionErrorEvent>;
  // Wildcard
  "*": StoreEventListener<StoreEvent>;
};

// ============================================================================
// Store State Types
// ============================================================================

/**
 * Overall store phase
 */
export type StorePhase = "idle" | "loading" | "streaming";

/**
 * Inflight navigation info
 */
export interface InflightNavigation {
  /** URL navigating from */
  fromUrl: string;
  /** URL navigating to */
  toUrl: string;
  /** When navigation started */
  startedAt: number;
  /** Current phase */
  phase: "loading" | "streaming";
}

/**
 * Readonly snapshot of store state for external consumers
 */
export interface StoreSnapshot {
  /** Overall phase (idle if nothing inflight, otherwise loading/streaming) */
  phase: StorePhase;
  /** Whether store has completed hydration */
  isHydrated: boolean;
  /** Current inflight navigation, if any */
  inflightNavigation: InflightNavigation | null;
  /** All inflight actions */
  inflightActions: readonly {
    id: string;
    actionId: string;
    payload: readonly unknown[];
    startedAt: number;
    phase: "loading" | "streaming";
  }[];
  /** Current location */
  location: URL;
  /** Whether any action or navigation is in progress */
  isBusy: boolean;
  /** Whether specifically a navigation is in progress */
  isNavigating: boolean;
  /** Whether any actions are in progress */
  hasInflightActions: boolean;
}

// ============================================================================
// Queued Callback Types
// ============================================================================

/**
 * Callback to run when store becomes idle
 */
export type IdleCallback = () => void | Promise<void>;
