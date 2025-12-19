"use client";

import { createContext, type Context } from "react";
import type { NavigationStore, NavigateOptions } from "../types.js";
import type { EventController } from "../event-controller.js";

/**
 * Navigation context value provided by NavigationProvider
 *
 * This context provides a STABLE reference to the store, event controller, and methods.
 * The store itself never changes, so context consumers don't re-render
 * when navigation state changes.
 *
 * Components subscribe to state changes via eventController.subscribe() in useNavigation.
 */
export interface NavigationStoreContextValue {
  /**
   * The navigation store instance (stable reference)
   * Used for cache/segment management
   */
  store: NavigationStore;

  /**
   * The event controller instance (stable reference)
   * Used for navigation/action state
   */
  eventController: EventController;

  /**
   * Navigate to a new URL
   *
   * @param url - The URL to navigate to
   * @param options - Navigation options (replace, scroll)
   * @returns Promise that resolves when navigation is complete
   */
  navigate: (url: string, options?: NavigateOptions) => Promise<void>;

  /**
   * Refresh the current route
   *
   * @returns Promise that resolves when refresh is complete
   */
  refresh: () => Promise<void>;
}

/**
 * React context for navigation store
 *
 * Provides stable reference to the store - does NOT re-render on state changes.
 * Use useNavigation hook for reactive state access.
 */
export const NavigationStoreContext: Context<NavigationStoreContextValue | null> =
  createContext<NavigationStoreContextValue | null>(null);

/**
 * SSR handle context value
 * Used during SSR to provide handle data before the full navigation store is available
 */
export interface SSRHandleContextValue {
  /** Handle entries from RSC metadata: { handleName: { segmentId: [entries] } } */
  handleEntries: Record<string, Record<string, unknown[]>>;
  /** Matched segment IDs in order (layouts first, then routes) */
  matchedSegmentIds: string[];
}

/**
 * React context for SSR handle data
 * Used by useHandle as a fallback during SSR when NavigationStoreContext isn't available
 */
export const SSRHandleContext: Context<SSRHandleContextValue | null> =
  createContext<SSRHandleContextValue | null>(null);
