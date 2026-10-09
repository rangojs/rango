"use client";

import { createContext, type Context } from "react";
import type { NavigationStore, NavigateOptionsInternal } from "../types.js";
import type { EventController } from "../event-controller.js";
import type { PrefetchStrategy } from "../../router/prefetch-default.js";
import type { LocationStateSnapshot } from "./location-state-shared.js";

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
  navigate: (url: string, options?: NavigateOptionsInternal) => Promise<void>;

  /**
   * Refresh the current route
   *
   * @returns Promise that resolves when refresh is complete
   */
  refresh: () => Promise<void>;

  /**
   * App version from the initial server payload.
   */
  version: string | undefined;

  /**
   * URL prefix for all routes (from createRouter({ basename })).
   * Used by Link and useRouter() to auto-prefix app-local paths.
   */
  basename: string | undefined;

  /** Router default from this instance's initial payload. */
  defaultPrefetch?: PrefetchStrategy;

  /**
   * The document's origin, fixed for its lifetime. Link compares absolute
   * hrefs against it (data-external) and useLinkStatus resolves link targets
   * with it.
   */
  origin: string | undefined;
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
 * The location state of the history entry whose tree is on screen, for
 * useLocationState. NavigationProvider holds it as React state next to the
 * payload and sets both in one update, so a render sees an entry's state
 * exactly when it sees that entry's tree: a transition React holds renders
 * the destination's value, an urgent render of the content still on screen
 * (a reader mounting there included) the value of the entry being left
 * (#1029). Undefined on the server and outside a provider.
 */
export const LocationStateContext: Context<LocationStateSnapshot> =
  createContext<LocationStateSnapshot>(undefined);

/**
 * Read by no component. NavigationProvider changes its value in a transition so
 * that React hydrates every boundary still dehydrated beneath it before that
 * commit: React hydrates a dehydrated boundary first when a provider above it
 * changes, and nothing re-renders for a value nobody reads. See
 * NavigationProviderProps.hydration.
 */
export const HydrationBarrierContext: Context<number> =
  createContext<number>(0);
