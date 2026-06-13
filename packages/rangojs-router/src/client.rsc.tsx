/**
 * RSC-environment version of client exports
 *
 * This file is used when importing "rsc-router/client" from RSC (server components).
 * It re-exports the server's createLoader so that loader definitions work in both
 * environments with the same import.
 *
 * The bundler uses the "react-server" export condition to select this file
 * in RSC context, while the regular client.tsx is used in client components.
 */

// Re-export everything from client.tsx (Outlet, useLoader, etc.)
// These are safe to use in RSC context
export {
  Outlet,
  ParallelOutlet,
  useOutlet,
  useLoader,
  ErrorBoundary,
  type ErrorBoundaryProps,
} from "./client.js";

// Re-export the server's createLoader for RSC context
// This version includes the actual loader function
export { createLoader } from "./route-definition.js";

// Re-export Link component (can be used in server components)
export {
  Link,
  type LinkProps,
  type PrefetchStrategy,
} from "./browser/react/Link.js";

// Re-export ScrollRestoration (can be used in server components)
export {
  ScrollRestoration,
  type ScrollRestorationProps,
} from "./browser/react/ScrollRestoration.js";

// Re-export NavigationProvider (needed for setup)
export {
  NavigationProvider,
  type NavigationProviderProps,
} from "./browser/react/NavigationProvider.js";

// Re-export href function (can be used in server components)
export { href } from "./href-client.js";

// Mount context re-exports (useMount is client-only, but MountContext can be referenced)
export { MountContext } from "./browser/react/mount-context.js";

// Note: useNavigation and useAction are NOT re-exported here
// because they use client-side state and should only be used in client components

// Handle API - for accumulating data across route segments
// Works in both RSC and client contexts
export { createHandle, isHandle, type Handle } from "./handle.js";

// Built-in handles
// Meta handle works in RSC context
export { Meta } from "./handles/meta.js";
// MetaTags is a "use client" component that can be imported from RSC
export { MetaTags } from "./handles/MetaTags.js";
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";
// Breadcrumbs handle works in RSC context
export { Breadcrumbs, type BreadcrumbItem } from "./handles/breadcrumbs.js";

// Location state - createLocationState works in RSC (just creates definition)
// useLocationState is NOT exported here as it uses client hooks
export {
  createLocationState,
  type LocationStateDefinition,
  type LocationStateEntry,
  type LocationStateOptions,
} from "./browser/react/location-state-shared.js";

// Re-export useHref - it's a "use client" hook
export { useHref } from "./browser/react/use-href.js";

// Re-export useReverse - it's a "use client" hook
export { useReverse } from "./browser/react/use-reverse.js";

// Re-export useHandle - it's a "use client" hook
export { useHandle } from "./browser/react/use-handle.js";

// Re-export useLocationState - it's a "use client" hook
export { useLocationState } from "./browser/react/location-state.js";
