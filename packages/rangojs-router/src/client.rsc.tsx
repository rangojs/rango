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
  OutletProvider,
  useOutlet,
  useLoader,
  useLoaderData,
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

// Note: useNavigation, useAction, useClientCache are NOT re-exported here
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

// Location state - createLocationState works in RSC (just creates definition)
// useLocationState is NOT exported here as it uses client hooks
export {
  createLocationState,
  type LocationStateDefinition,
  type LocationStateEntry,
} from "./browser/react/location-state-shared.js";

// Stub exports for client-only hooks
// These satisfy esbuild's dependency scan but throw if accidentally used in RSC
function clientOnlyHookError(hookName: string): never {
  throw new Error(
    `${hookName}() can only be used in client components. ` +
      `Add "use client" directive at the top of your file.`
  );
}

export function useHandle(): never {
  return clientOnlyHookError("useHandle");
}

export function useLocationState(): never {
  return clientOnlyHookError("useLocationState");
}
