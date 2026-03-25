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

  /**
   * App version from server payload (stable, immutable).
   * Useful for building cache keys. For the *current* version
   * (which may change after HMR), use getAppVersion() instead.
   */
  version: string | undefined;
}

/**
 * React context for navigation store
 *
 * Provides stable reference to the store - does NOT re-render on state changes.
 * Use useNavigation hook for reactive state access.
 */
export const NavigationStoreContext: Context<NavigationStoreContextValue | null> =
  createContext<NavigationStoreContextValue | null>(null);
