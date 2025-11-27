// ============================================================================
// Browser Module - Client-side navigation utilities for RSC Router
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
  type NavigationStoreConfig,
} from "./navigation-store.js";
export { createRequestController } from "./request-controller.js";
export { createNavigationClient } from "./navigation-client.js";
export {
  setupLinkInterception,
  defaultShouldIntercept,
} from "./link-interceptor.js";
export { createServerActionBridge } from "./server-action-bridge.js";
export { createNavigationBridge } from "./navigation-bridge.js";

// Shallow comparison utility
export { shallow } from "./shallow.js";

// React integration
export {
  NavigationStoreContext,
  type NavigationStoreContextValue,
  useNavigation,
  type NavigationMethods,
  type NavigationValue,
  NavigationProvider,
  type NavigationProviderProps,
  Link,
  type LinkProps,
  type PrefetchStrategy,
} from "./react/index.js";
