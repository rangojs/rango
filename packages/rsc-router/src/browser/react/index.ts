// React exports for browser navigation

// Hook with Zustand-style selectors
export {
  useNavigation,
  type NavigationMethods,
  type NavigationValue,
} from "./use-navigation.js";

// Client cache controls hook
export {
  useClientCache,
  type ClientCacheControls,
} from "./use-client-cache.js";

// Provider
export {
  NavigationProvider,
  type NavigationProviderProps,
} from "./NavigationProvider.js";

// Context (for advanced usage)
export {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "./context.js";

// Link component
export {
  Link,
  type LinkProps,
  type PrefetchStrategy,
} from "./Link.js";
