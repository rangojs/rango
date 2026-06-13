// Internal React barrel for browser navigation.
//
// This barrel is not a package.json subpath, so it is internal-only; its sole
// importer (browser/rsc-router.tsx) consumes only NavigationProvider. The
// public hook/component surface (useNavigation, useRouter, Link, etc.) is
// re-exported directly from its source modules by the ./client barrel — do not
// duplicate it here, or the two surfaces drift.

// Provider
export {
  NavigationProvider,
  type NavigationProviderProps,
} from "./NavigationProvider.js";
