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
  type ResolvedSegment,
} from "./types";
import {
  RouteContentWrapper,
  LoaderBoundary,
} from "./route-content-wrapper.js";
import { OutletProvider } from "./outlet-provider.js";
import { MountContextProvider } from "./browser/react/mount-context.js";
import { getMemoizedContentPromise } from "./segment-content-promise.js";

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
          content={getMemoizedContentPromise(segment, segment.component)}
          fallback={segment.loading}
          segmentId={segment.id}
        />
      );
    } else {
      content = segment.component ?? null;
    }

    let result: ReactNode;

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

        result = (
          <OutletProvider content={loaderAwareContent} segment={segment}>
            {segment.layout}
          </OutletProvider>
        );
      } else {
        // No loaders - wrap in OutletProvider so layout can use <Outlet />
        result = (
          <OutletProvider content={content} segment={segment}>
            {segment.layout}
          </OutletProvider>
        );
      }
    } else if (segment.loaderDataPromise && segment.loaderIds) {
      // No layout but has loaders - wrap content with LoaderBoundary for useLoader context
      // This is common for intercept routes that use useLoader without a custom layout
      result = (
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
    } else {
      result = content;
    }

    // Wrap with MountContextProvider for include() scoped parallel/intercept slots
    if (segment.mountPath) {
      return (
        <MountContextProvider value={segment.mountPath}>
          {result}
        </MountContextProvider>
      );
    }

    return result;
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
        content={getMemoizedContentPromise(segment, segment.component)}
        fallback={segment.loading}
        segmentId={segment.id}
      />
    );
  } else {
    content = segment.component ?? null;
  }

  let result: ReactNode;

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

      result = (
        <OutletProvider content={loaderAwareContent} segment={segment}>
          {segment.layout}
        </OutletProvider>
      );
    } else {
      // No loaders - wrap in OutletProvider so layout can use <Outlet />
      result = (
        <OutletProvider content={content} segment={segment}>
          {segment.layout}
        </OutletProvider>
      );
    }
  } else if (segment.loaderDataPromise && segment.loaderIds) {
    // No layout but has loaders - wrap content with LoaderBoundary for useLoader context
    // This is common for intercept routes that use useLoader without a custom layout
    result = (
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
  } else {
    result = content;
  }

  // Wrap with MountContextProvider for include() scoped parallel/intercept slots
  if (segment.mountPath) {
    return (
      <MountContextProvider value={segment.mountPath}>
        {result}
      </MountContextProvider>
    );
  }

  return result;
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
export { useNavigation } from "./browser/react/use-navigation.js";
export { useRouter } from "./browser/react/use-router.js";
export { usePathname } from "./browser/react/use-pathname.js";
export { useSearchParams } from "./browser/react/use-search-params.js";
export { useParams } from "./browser/react/use-params.js";
export type {
  RouterInstance,
  RouterNavigateOptions,
  ReadonlyURLSearchParams,
} from "./browser/types.js";

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

// Handle data hook (client-side only — createHandle/isHandle are server APIs from the root export)
export { type Handle } from "./handle.js";
export { useHandle } from "./browser/react/use-handle.js";

// Built-in handles
export { Meta } from "./handles/meta.js";
export { MetaTags } from "./handles/MetaTags.js";
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";
export { Breadcrumbs, type BreadcrumbItem } from "./handles/breadcrumbs.js";

// Location state - type-safe navigation state
export {
  createLocationState,
  useLocationState,
  type LocationStateDefinition,
  type LocationStateEntry,
  type LocationStateOptions,
} from "./browser/react/location-state.js";

// Type-safe href for client-side path validation
export {
  href,
  type ValidPaths,
  type PatternToPath,
  type PathResponse,
} from "./href-client.js";

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
  result: import("./urls.js").ResponseEnvelope<T>,
): result is import("./urls.js").ResponseEnvelope<T> & {
  error: import("./urls.js").ResponseError;
} {
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
