/**
 * Cross-Tab Sync Strategy
 *
 * Pluggable strategy for cross-tab cache invalidation and communication.
 * Allows custom implementations for different transport mechanisms
 * (BroadcastChannel, localStorage, WebSocket, Service Worker, etc.)
 */

/**
 * Invalidation mode for cross-tab cache events
 */
export type InvalidationMode =
  | "clear"    // Clear cache only, refetch on next navigation
  | "refresh"; // Clear cache and trigger immediate refetch

/**
 * Events that can be broadcast across tabs
 */
export type CrossTabEvent =
  | { type: "invalidate"; path: string; actionId?: string; mode?: InvalidationMode }
  | { type: "custom"; name: string; payload: unknown };

/**
 * Custom event for userland handlers
 */
export interface CustomCrossTabEvent {
  name: string;
  payload: unknown;
}

/**
 * Readonly inflight action info for strategy decision-making
 */
export interface CrossTabInflightAction {
  /** Unique identifier for this action invocation */
  readonly id: string;
  /** Server action function ID */
  readonly actionId: string;
  /** Action arguments (readonly copy) */
  readonly payload: readonly unknown[];
  /** Timestamp when action started */
  readonly startedAt: number;
}

/**
 * Readonly navigation state snapshot for strategy decision-making
 */
export interface CrossTabNavigationState {
  /** Current navigation state ("idle" or "loading") */
  readonly state: "idle" | "loading";
  /** Whether RSC data is currently streaming */
  readonly isStreaming: boolean;
  /** Current URL pathname */
  readonly pathname: string;
  /** Current full URL */
  readonly url: string;
  /** Inflight server actions with full payload */
  readonly inflightActions: readonly CrossTabInflightAction[];

  // Transaction/form state
  /** Whether a server action is currently in progress */
  readonly isActionInProgress: boolean;
  /** Form action URL if form submission is in progress */
  readonly formAction: string | null;
  /** Whether there's an active form submission */
  readonly hasActiveFormSubmission: boolean;
}

/**
 * Context provided to the strategy by the navigation store.
 * Allows the strategy to interact with store internals.
 */
export interface CrossTabSyncContext {
  /**
   * Get the current pathname
   */
  getCurrentPath(): string;

  /**
   * Get readonly snapshot of current navigation state.
   * Useful for making decisions based on current state.
   */
  getState(): CrossTabNavigationState;

  /**
   * Clear the navigation history cache
   */
  clearCache(): void;

  /**
   * Trigger a refresh/revalidation for the given path
   */
  triggerRefresh(path: string): void;

  /**
   * Emit a custom event to userland listeners
   */
  emitCustomEvent(event: CustomCrossTabEvent): void;
}

/**
 * Cross-tab sync strategy interface.
 * Implement this to create custom cross-tab communication.
 */
export interface CrossTabSyncStrategy {
  /**
   * Initialize the strategy with store context.
   * Set up listeners and channels here.
   */
  init(context: CrossTabSyncContext): void;

  /**
   * Broadcast an event to other tabs.
   * Called when cache is invalidated or custom events are sent.
   */
  broadcast(event: CrossTabEvent): void;

  /**
   * Clean up resources when store is destroyed.
   */
  destroy(): void;

  /**
   * Determine if cache should be invalidated based on paths and action.
   * Called when receiving an invalidation event from another tab.
   *
   * @param mutatedPath - The path where mutation occurred (from other tab)
   * @param currentPath - The current tab's path
   * @param actionId - The action ID that triggered the invalidation (if available)
   * @returns true if cache should be invalidated
   */
  shouldInvalidate(mutatedPath: string, currentPath: string, actionId?: string): boolean;
}

/**
 * Options for the BroadcastChannel strategy
 */
export interface BroadcastChannelStrategyOptions {
  /**
   * BroadcastChannel name (default: "rsc-router-cache-invalidation")
   */
  channelName?: string;

  /**
   * Auto-refresh when cache is invalidated by another tab (default: true)
   */
  autoRefresh?: boolean;

  /**
   * Custom invalidation logic.
   * Override to change when cache invalidation applies.
   *
   * @param mutatedPath - The path where mutation occurred
   * @param currentPath - The current tab's path
   * @param actionId - The action ID that triggered the invalidation
   *
   * Default: related paths (exact match or parent/child relationship)
   */
  shouldInvalidate?: (mutatedPath: string, currentPath: string, actionId?: string) => boolean;
}

/**
 * Default path matching: related paths (exact match or parent/child relationship)
 * The actionId parameter is available for custom implementations but not used by default.
 */
export function defaultShouldInvalidate(
  mutatedPath: string,
  currentPath: string,
  _actionId?: string
): boolean {
  return (
    mutatedPath === currentPath ||
    currentPath.startsWith(mutatedPath + "/") ||
    mutatedPath.startsWith(currentPath + "/")
  );
}

/**
 * Create a BroadcastChannel-based cross-tab sync strategy.
 * This is the default strategy used by the navigation store.
 *
 * @example
 * ```typescript
 * // Default behavior
 * const store = createNavigationStore({
 *   crossTabSync: createBroadcastChannelStrategy(),
 * });
 *
 * // Custom path matching - only exact paths
 * const store = createNavigationStore({
 *   crossTabSync: createBroadcastChannelStrategy({
 *     shouldInvalidate: (mutated, current) => mutated === current,
 *   }),
 * });
 *
 * // Disable auto-refresh
 * const store = createNavigationStore({
 *   crossTabSync: createBroadcastChannelStrategy({
 *     autoRefresh: false,
 *   }),
 * });
 * ```
 */
export function createBroadcastChannelStrategy(
  options?: BroadcastChannelStrategyOptions
): CrossTabSyncStrategy {
  const channelName = options?.channelName ?? "rsc-router-cache-invalidation";
  const autoRefresh = options?.autoRefresh !== false;
  const shouldInvalidateFn = options?.shouldInvalidate ?? defaultShouldInvalidate;

  let channel: BroadcastChannel | null = null;
  let context: CrossTabSyncContext | null = null;

  return {
    init(ctx) {
      context = ctx;

      // BroadcastChannel not available in SSR or older browsers
      if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
        return;
      }

      channel = new BroadcastChannel(channelName);

      channel.onmessage = (event) => {
        if (!context) return;

        // Handle cache invalidation events
        if (event.data?.type === "invalidate") {
          const mutatedPath = event.data.path;
          const actionId = event.data.actionId;
          const mode = event.data.mode as InvalidationMode | undefined;
          const currentPath = context.getCurrentPath();

          // Use strategy's shouldInvalidate to decide
          if (!this.shouldInvalidate(mutatedPath, currentPath, actionId)) {
            return;
          }

          console.log("[CrossTabSync] Cache invalidated by another tab", actionId ? `(action: ${actionId})` : "", mode ? `[${mode}]` : "");
          context.clearCache();

          // Determine whether to refresh:
          // - mode="refresh" -> always refresh
          // - mode="clear" -> never refresh
          // - mode undefined -> use autoRefresh setting
          const shouldRefresh = mode === "refresh" || (mode !== "clear" && autoRefresh);
          if (shouldRefresh) {
            context.triggerRefresh(mutatedPath);
          }
        }

        // Handle custom events for userland
        if (event.data?.type === "custom") {
          context.emitCustomEvent({
            name: event.data.name,
            payload: event.data.payload,
          });
        }
      };
    },

    broadcast(event) {
      if (!channel) {
        // No channel available (SSR or not initialized)
        return;
      }

      channel.postMessage(event);

      if (event.type === "invalidate") {
        console.log("[CrossTabSync] Broadcast sent for path:", event.path);
      }
    },

    destroy() {
      channel?.close();
      channel = null;
      context = null;
    },

    shouldInvalidate: shouldInvalidateFn,
  };
}

/**
 * Default cross-tab sync strategy factory.
 * Uses BroadcastChannel with default options.
 */
export const defaultCrossTabSyncStrategy: (
  options?: BroadcastChannelStrategyOptions
) => CrossTabSyncStrategy = createBroadcastChannelStrategy;
