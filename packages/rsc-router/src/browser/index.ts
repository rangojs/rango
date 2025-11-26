// ============================================================================
// Browser Module - Client-side navigation utilities for RSC Router
// ============================================================================

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
} from "./react/index.js";
