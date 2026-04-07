// React exports for browser navigation

// Hook with Zustand-style selectors
export { useNavigation } from "./use-navigation.js";

// Router actions hook (stable reference, no re-renders)
export { useRouter } from "./use-router.js";

// URL hooks
export { usePathname } from "./use-pathname.js";
export { useSearchParams } from "./use-search-params.js";
export { useParams } from "./use-params.js";

// Action state tracking hook
export { useAction, type TrackedActionState } from "./use-action.js";

// Segments state hook
export { useSegments, type SegmentsState } from "./use-segments.js";

// Handle data hook
export { useHandle } from "./use-handle.js";

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
export { Link, type LinkProps, type PrefetchStrategy } from "./Link.js";

// Link status hook
export { useLinkStatus, type LinkStatus } from "./use-link-status.js";

// Scroll restoration
export {
  ScrollRestoration,
  useScrollRestoration,
  type ScrollRestorationProps,
} from "./ScrollRestoration.js";
