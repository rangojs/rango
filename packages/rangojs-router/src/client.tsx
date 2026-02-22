"use client";

import {
  Component,
  createElement,
  useContext,
  useMemo,
  Suspense,
  type ReactNode,
} from "react";
import { OutletContext, type OutletContextValue } from "./outlet-context.js";
import {
  type ClientErrorBoundaryFallbackProps,
  type ErrorInfo,
  type LoaderDefinition,
  type LoaderFn,
  type ResolvedSegment,
} from "./types";
import {
  RouteContentWrapper,
  LoaderBoundary,
} from "./route-content-wrapper.js";
import { OutletProvider } from "./outlet-provider.js";

/**
 * Outlet component - renders child content in layouts
 *
 * If the current segment defines a loading component, the outlet content
 * is wrapped in Suspense with the loading component as fallback.
 * This means during navigation/streaming, React's Suspense will automatically
 * show the loading skeleton until the content is ready.
 *
 * When a name prop is provided (e.g., "@modal"), renders content from
 * the parallel segment with that slot name instead of the default content.
 * This is used for parallel routes and intercepting routes.
 *
 * @param name - Optional slot name for parallel/intercept content (must start with @)
 *
 * @example
 * ```tsx
 * function BlogLayout() {
 *   return (
 *     <div>
 *       <h1>Blog</h1>
 *       <Outlet />
 *     </div>
 *   );
 * }
 *
 * // With named slot for modal/parallel content:
 * function KanbanLayout() {
 *   return (
 *     <div>
 *       <KanbanBoard />
 *       <Outlet name="@modal" />
 *       <Outlet />
 *     </div>
 *   );
 * }
 * ```
 */
export function Outlet({ name }: { name?: `@${string}` } = {}): ReactNode {
  const context = useContext(OutletContext);

  // If name provided, render parallel/intercept content for that slot
  if (name) {
    const segment = context?.parallel?.find((seg) => seg.slot === name) ?? null;

    if (!segment) return null;

    // Determine the content to render
    let content: ReactNode;
    if (segment.loading || segment.component instanceof Promise) {
      // Use RouteContentWrapper to handle Suspense wrapping properly
      content = (
        <RouteContentWrapper
          content={
            segment.component instanceof Promise
              ? segment.component
              : Promise.resolve(segment.component)
          }
          fallback={segment.loading}
          segmentId={segment.id}
        />
      );
    } else {
      content = segment.component ?? null;
    }

    // If segment has a layout, wrap appropriately
    if (segment.layout) {
      // Check if this segment has loaders that need streaming
      // The layout renders immediately, LoaderBoundary becomes the outlet content
      // When layout renders <Outlet />, it gets the LoaderBoundary which suspends
      if (segment.loaderDataPromise && segment.loaderIds) {
        const loaderAwareContent = (
          <LoaderBoundary
            loaderDataPromise={segment.loaderDataPromise}
            loaderIds={segment.loaderIds}
            fallback={segment.loading}
            outletKey={segment.id + "-loader"}
            outletContent={null}
            segment={segment}
          >
            {content}
          </LoaderBoundary>
        );

        return (
          <OutletProvider content={loaderAwareContent} segment={segment}>
            {segment.layout}
          </OutletProvider>
        );
      }

      // No loaders - wrap in OutletProvider so layout can use <Outlet />
      return (
        <OutletProvider content={content} segment={segment}>
          {segment.layout}
        </OutletProvider>
      );
    }

    // No layout but has loaders - wrap content with LoaderBoundary for useLoader context
    // This is common for intercept routes that use useLoader without a custom layout
    if (segment.loaderDataPromise && segment.loaderIds) {
      return (
        <LoaderBoundary
          loaderDataPromise={segment.loaderDataPromise}
          loaderIds={segment.loaderIds}
          fallback={segment.loading}
          outletKey={segment.id + "-loader"}
          outletContent={null}
          segment={segment}
        >
          {content}
        </LoaderBoundary>
      );
    }

    return content;
  }

  // Default: render child content
  const content = context?.content ?? null;

  // If this segment defines a loading component, wrap outlet content with Suspense
  // The loading component becomes the Suspense fallback, shown during streaming/navigation
  if (context?.loading) {
    return <Suspense fallback={context.loading}>{content}</Suspense>;
  }

  return content;
}
/**
 * ParallelOutlet component - renders content for a named parallel slot
 *
 * If the parallel segment defines a loading component, the content
 * is wrapped in Suspense with the loading component as fallback.
 * This enables streaming and navigation loading states for parallels.
 *
 * @param name - The slot name (must start with @, e.g., "@modal", "@sidebar")
 *
 * @example
 * ```tsx
 * function DashboardLayout() {
 *   return (
 *     <div>
 *       <h1>Dashboard</h1>
 *       <ParallelOutlet name="@sidebar" />
 *       <ParallelOutlet name="@modal" />
 *     </div>
 *   );
 * }
 * ```
 */
export function ParallelOutlet({ name }: { name: `@${string}` }): ReactNode {
  const context = useContext(OutletContext);
  const segment = useMemo(() => {
    if (!context?.parallel) return null;
    return context.parallel.find((seg) => seg.slot === name) ?? null;
  }, [context, name]);

  if (!segment) return null;

  // Determine the content to render
  let content: ReactNode;
  if (segment.loading || segment.component instanceof Promise) {
    // Use RouteContentWrapper to handle Suspense wrapping properly
    content = (
      <RouteContentWrapper
        content={
          segment.component instanceof Promise
            ? segment.component
            : Promise.resolve(segment.component)
        }
        fallback={segment.loading}
        segmentId={segment.id}
      />
    );
  } else {
    content = segment.component ?? null;
  }

  // If segment has a layout, wrap appropriately
  if (segment.layout) {
    // Check if this segment has loaders that need streaming
    // The layout renders immediately, LoaderBoundary becomes the outlet content
    if (segment.loaderDataPromise && segment.loaderIds) {
      const loaderAwareContent = (
        <LoaderBoundary
          loaderDataPromise={segment.loaderDataPromise}
          loaderIds={segment.loaderIds}
          fallback={segment.loading}
          outletKey={segment.id + "-loader"}
          outletContent={null}
          segment={segment}
        >
          {content}
        </LoaderBoundary>
      );

      return (
        <OutletProvider content={loaderAwareContent} segment={segment}>
          {segment.layout}
        </OutletProvider>
      );
    }

    // No loaders - wrap in OutletProvider so layout can use <Outlet />
    return (
      <OutletProvider content={content} segment={segment}>
        {segment.layout}
      </OutletProvider>
    );
  }

  // No layout but has loaders - wrap content with LoaderBoundary for useLoader context
  // This is common for intercept routes that use useLoader without a custom layout
  if (segment.loaderDataPromise && segment.loaderIds) {
    return (
      <LoaderBoundary
        loaderDataPromise={segment.loaderDataPromise}
        loaderIds={segment.loaderIds}
        fallback={segment.loading}
        outletKey={segment.id + "-loader"}
        outletContent={null}
        segment={segment}
      >
        {content}
      </LoaderBoundary>
    );
  }

  return content;
}

// OutletProvider is defined in outlet-provider.tsx to break a circular
// dependency between client.tsx and route-content-wrapper.tsx.
// Imported at the top of this file for local use in Outlet/ParallelOutlet,
// and re-exported here for backwards compatibility.
export { OutletProvider };

/**
 * Hook to access outlet content programmatically
 *
 * Alternative to using <Outlet /> component. Useful when you need
 * direct access to the outlet content in your logic.
 *
 * @example
 * ```tsx
 * function BlogLayout() {
 *   const outlet = useOutlet();
 *   return <div><h1>Blog</h1>{outlet}</div>;
 * }
 * ```
 */
export function useOutlet(): ReactNode {
  const context = useContext(OutletContext);
  return context?.content ?? null;
}

// Loader hooks - re-exported from dedicated file
export {
  useLoader,
  useFetchLoader,
  type LoadFunction,
  type UseLoaderResult,
  type UseFetchLoaderResult,
  type UseLoaderOptions,
} from "./use-loader.js";

/**
 * Hook to access all loader data in the current context
 *
 * Returns a record of all loader data available in the current outlet context
 * and all parent contexts. Useful for debugging or when you need access to
 * multiple loaders.
 *
 * @returns Record of loader name to data, or empty object if no loaders
 *
 * @example
 * ```tsx
 * "use client";
 * import { useLoaderData } from "rsc-router/client";
 *
 * export function DebugPanel() {
 *   const loaderData = useLoaderData();
 *   return <pre>{JSON.stringify(loaderData, null, 2)}</pre>;
 * }
 * ```
 */
export function useLoaderData(): Record<string, any> {
  const context = useContext(OutletContext);

  // Collect all loader data from the context chain
  // Child loaders override parent loaders with the same name
  const result: Record<string, any> = {};
  const stack: OutletContextValue[] = [];

  // Build stack from current to root
  let current: OutletContextValue | null | undefined = context;
  while (current) {
    stack.push(current);
    current = current.parent;
  }

  // Apply from root to current (so children override parents)
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (ctx.loaderData) {
      Object.assign(result, ctx.loaderData);
    }
  }

  return result;
}

/**
 * Client-safe createLoader factory
 *
 * Creates a loader definition that can be used with useLoader().
 * This is the client-side version that only stores the $$id - the function
 * is ignored since loaders only execute on the server.
 *
 * The $$id is injected by the exposeLoaderId Vite plugin. In most cases,
 * you should import the loader directly from the server file rather than
 * creating a reference manually.
 *
 * @param fn - Loader function (ignored on client, kept for API compatibility)
 * @param _fetchable - Optional fetchable flag (ignored on client)
 * @param __injectedId - $$id injected by Vite plugin
 *
 * @example
 * ```tsx
 * "use client";
 * import { useLoader } from "rsc-router/client";
 * import { CartLoader } from "../loaders/cart"; // Import from server file
 *
 * export function CartIcon() {
 *   const cart = useLoader(CartLoader);
 *   return <span>Cart ({cart?.items.length ?? 0})</span>;
 * }
 * ```
 */
// Overload 1: With function only (not fetchable)
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 2: With function and fetchable flag
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  fetchable: true
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Implementation - function is ignored at runtime on client
// The $$id is injected by Vite plugin as hidden third parameter
export function createLoader(
  _fn: LoaderFn<any, Record<string, string | undefined>, any>,
  _fetchable?: true,
  __injectedId?: string
): LoaderDefinition<any, Record<string, string | undefined>> {
  return {
    __brand: "loader",
    $$id: __injectedId || "",
  };
}

/**
 * Props for the ErrorBoundary component
 */
export interface ErrorBoundaryProps {
  /** Fallback UI to show when an error is caught */
  fallback:
    | ReactNode
    | ((props: ClientErrorBoundaryFallbackProps) => ReactNode);
  /** Children to render */
  children: ReactNode;
  /** Optional callback when an error is caught */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Client-side ErrorBoundary component
 *
 * Catches JavaScript errors in child components during rendering,
 * in lifecycle methods, and in constructors of the whole tree below them.
 * Displays a fallback UI instead of the component tree that crashed.
 *
 * Use this to wrap client components that might throw during hydration
 * or user interaction. For server-side errors (middleware, loaders, handlers),
 * use the errorBoundary() helper in route definitions instead.
 *
 * @example
 * ```tsx
 * "use client";
 * import { ErrorBoundary } from "rsc-router/client";
 *
 * function MyComponent() {
 *   return (
 *     <ErrorBoundary fallback={<div>Something went wrong</div>}>
 *       <ComponentThatMightThrow />
 *     </ErrorBoundary>
 *   );
 * }
 *
 * // Or with a function fallback for more control:
 * function MyComponent() {
 *   return (
 *     <ErrorBoundary
 *       fallback={({ error, reset }) => (
 *         <div>
 *           <p>Error: {error.message}</p>
 *           <button onClick={reset}>Try again</button>
 *         </div>
 *       )}
 *     >
 *       <ComponentThatMightThrow />
 *     </ErrorBoundary>
 *   );
 * }
 * ```
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[ErrorBoundary] Error caught:", error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      const { fallback } = this.props;

      // Create error info for the fallback
      const errorInfo: ErrorInfo = {
        message: this.state.error.message,
        name: this.state.error.name,
        stack: this.state.error.stack,
        cause: this.state.error.cause,
        segmentId: "client",
        segmentType: "route",
      };

      // Render fallback - use createElement so hooks work in function fallbacks
      if (typeof fallback === "function") {
        return createElement(fallback, { error: errorInfo, reset: this.reset });
      }

      return fallback;
    }

    return this.props.children;
  }
}

// ============================================================================
// Re-exports from browser/react for convenience
// These are the most commonly used client-side navigation utilities
// ============================================================================

// Navigation hooks
export {
  useNavigation,
  type NavigationMethods,
  type NavigationValue,
} from "./browser/react/use-navigation.js";

// Action state tracking hook
export {
  useAction,
  type ServerActionFunction,
} from "./browser/react/use-action.js";

// Segments state hook
export {
  useSegments,
  type SegmentsState,
} from "./browser/react/use-segments.js";

// Client cache controls hook
export {
  useClientCache,
  type ClientCacheControls,
} from "./browser/react/use-client-cache.js";

// Provider
export {
  NavigationProvider,
  type NavigationProviderProps,
} from "./browser/react/NavigationProvider.js";

// Link component
export {
  Link,
  type LinkProps,
  type PrefetchStrategy,
  type StateOrGetter,
} from "./browser/react/Link.js";

// Link status hook
export {
  useLinkStatus,
  type LinkStatus,
} from "./browser/react/use-link-status.js";

// Scroll restoration
export {
  ScrollRestoration,
  useScrollRestoration,
  type ScrollRestorationProps,
} from "./browser/react/ScrollRestoration.js";

// Handle API - for accumulating data across route segments
export { createHandle, isHandle, type Handle } from "./handle.js";

// Handle data hook
export { useHandle } from "./browser/react/use-handle.js";

// Built-in handles
export { Meta } from "./handles/meta.js";
export { MetaTags } from "./handles/MetaTags.js";
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";

// Location state - type-safe navigation state
export {
  createLocationState,
  useLocationState,
  type LocationStateDefinition,
  type LocationStateEntry,
  type LocationStateOptions,
} from "./browser/react/location-state.js";

// Type-safe href for client-side path validation
export { href, type ValidPaths, type PatternToPath, type PathResponse } from "./href-client.js";

// Response envelope types for consuming JSON response routes
export type { ResponseEnvelope, ResponseError } from "./urls.js";

/**
 * Type guard for checking if a response envelope contains an error.
 *
 * @example
 * ```typescript
 * const result: ResponseEnvelope<Product> = await fetch(url).then(r => r.json());
 * if (isResponseError(result)) {
 *   console.log(result.error.message, result.error.code);
 *   return;
 * }
 * result.data // fully typed as Product
 * ```
 */
export function isResponseError<T>(
  result: import("./urls.js").ResponseEnvelope<T>
): result is import("./urls.js").ResponseEnvelope<T> & { error: import("./urls.js").ResponseError } {
  return result.error !== undefined;
}

// Mount context for include() scoped components
export { useMount } from "./browser/react/use-mount.js";
export { MountContext } from "./browser/react/mount-context.js";

// Mount-aware href hook - auto-prefixes paths with include() mount
export { useHref } from "./browser/react/use-href.js";

// Type-safe scoped reverse function for scopedReverse<typeof patterns>()
export type { ScopedReverseFunction } from "./reverse.js";

// Loader definition type - for typing loader props in client components
export type { LoaderDefinition } from "./types.js";
