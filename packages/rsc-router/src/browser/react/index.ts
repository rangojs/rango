// React exports for browser navigation

// Hook with Zustand-style selectors
export {
  useNavigation,
  type NavigationMethods,
  type NavigationValue,
} from "./use-navigation.js";

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
