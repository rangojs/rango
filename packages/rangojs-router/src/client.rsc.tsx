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

export { createLoader } from "./route-definition.js";

export {
  Link,
  type LinkProps,
  type PrefetchStrategy,
} from "./browser/react/Link.js";

export {
  ScrollRestoration,
  type ScrollRestorationProps,
} from "./browser/react/ScrollRestoration.js";

export {
  NavigationProvider,
  type NavigationProviderProps,
} from "./browser/react/NavigationProvider.js";

export { href } from "./href-client.js";

export { MountContext } from "./browser/react/mount-context.js";

// useNavigation and useAction are NOT re-exported here because they use client-side state

export { createHandle, isHandle, type Handle } from "./handle.js";

export { Meta } from "./handles/meta.js";
export { MetaTags } from "./handles/MetaTags.js";
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";
export { Breadcrumbs, type BreadcrumbItem } from "./handles/breadcrumbs.js";

export {
  createLocationState,
  type LocationStateDefinition,
  type LocationStateEntry,
  type LocationStateOptions,
} from "./browser/react/location-state-shared.js";

export { useHref } from "./browser/react/use-href.js";

export { useReverse } from "./browser/react/use-reverse.js";

export { useHandle } from "./browser/react/use-handle.js";
// Type a deferred-aware consumer narrows: an accumulated entry may be a Promise
// (a `ctx.use(Handle).defer()` slot) until it resolves.
export type { DeferredHandleEntry } from "./defer.js";

export { useLocationState } from "./browser/react/location-state.js";
