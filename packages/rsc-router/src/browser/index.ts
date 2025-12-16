// ============================================================================
// Browser Module - Low-level client-side navigation utilities for RSC Router
// ============================================================================
//
// For most use cases, import from "rsc-router/client" instead:
//   import { Link, useNavigation, useAction, NavigationProvider } from "rsc-router/client";
//
// This module exports low-level APIs for advanced customization and
// building custom navigation implementations.
// ============================================================================

// Route map builder (client-safe)
export {
  createRouteMap,
  registerRouteMap,
  type RouteMapBuilder,
} from "../route-map-builder.js";

// Client-safe route helper
export { route } from "../route-utils.js";

// Type-safe href function
export { href } from "./href.js";

// Types
export type {
  RscPayload,
  RscMetadata,
  ActionResult,
  NavigationLocation,
  NavigationState,
  PublicNavigationState,
  TrackedActionState,
  ActionLifecycleState,
  ActionStateListener,
  SegmentState,
  NavigationUpdate,
  NavigateOptions,
  RscBrowserDependencies,
  UpdateSubscriber,
  StateListener,
  NavigationStore,
  RequestController,
  FetchPartialOptions,
  NavigationClient,
  LinkInterceptorOptions,
  ServerActionBridge,
  ServerActionBridgeConfig,
  NavigationBridge,
  NavigationBridgeConfig,
  ResolvedSegment,
} from "./types.js";

// Core utilities
export {
  createNavigationStore,
  initNavigationStore,
  getNavigationStore,
  resetNavigationStore,
  generateHistoryKey,
  type NavigationStoreConfig,
} from "./navigation-store.js";
export { createRequestController } from "./request-controller.js";
export { createNavigationClient } from "./navigation-client.js";
export {
  setupLinkInterception,
  defaultShouldIntercept,
} from "./link-interceptor.js";
export {
  createServerActionBridge,
  type ServerActionBridgeConfigWithController,
} from "./server-action-bridge.js";
export {
  createNavigationBridge,
  type NavigationBridgeConfigWithController,
} from "./navigation-bridge.js";

// Event controller for reactive state management
export {
  createEventController,
  initEventController,
  getEventController,
  resetEventController,
  type EventController,
  type EventControllerConfig,
  type NavigationHandle,
  type ActionHandle,
  type NavigationEntry,
  type ActionEntry,
  type DerivedNavigationState,
} from "./event-controller.js";

// Shallow comparison utility
export { shallow } from "./shallow.js";

// Scroll restoration utilities (for advanced usage)
export {
  initScrollRestoration,
  handleNavigationStart,
  handleNavigationEnd,
  saveCurrentScrollPosition,
  restoreScrollPosition,
  cancelScrollRestorationPolling,
  scrollToHash,
  scrollToTop,
  getHistoryStateKey,
} from "./scroll-restoration.js";

// ============================================================================
// Re-exports from React integration (for backwards compatibility)
// Prefer importing these from "rsc-router/client" instead
// ============================================================================
export {
  NavigationStoreContext,
  type NavigationStoreContextValue,
  useNavigation,
  type NavigationMethods,
  type NavigationValue,
  useAction,
  useClientCache,
  type ClientCacheControls,
  NavigationProvider,
  type NavigationProviderProps,
  Link,
  type LinkProps,
  type PrefetchStrategy,
  ScrollRestoration,
  useScrollRestoration,
  type ScrollRestorationProps,
} from "./react/index.js";
