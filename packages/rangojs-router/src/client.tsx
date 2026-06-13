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
 * Render the content for a named parallel/intercept slot segment.
 *
 * Shared by Outlet (with `name` prop) and ParallelOutlet — both resolve a
 * segment from context.parallel by slot name and then render it through the
 * same layout/loader/mountPath wrapping pipeline.
 */
function renderSlotContent(segment: ResolvedSegment | null): ReactNode {
  if (!segment) return null;

  const content: ReactNode =
    segment.loading || segment.component instanceof Promise ? (
      <RouteContentWrapper
        content={getMemoizedContentPromise(segment.component)}
        fallback={segment.loading}
        segmentId={segment.id}
      />
    ) : (
      (segment.component ?? null)
    );

  const hasOwnLoaders = !!(segment.loaderDataPromise && segment.loaderIds);
  const loaderWrapped = hasOwnLoaders ? (
    <LoaderBoundary
      loaderDataPromise={segment.loaderDataPromise!}
      loaderIds={segment.loaderIds!}
      fallback={segment.loading}
      outletKey={segment.id + "-loader"}
      outletContent={null}
      segment={segment}
    >
      {content}
    </LoaderBoundary>
  ) : null;

  let result: ReactNode;
  if (segment.layout) {
    // Layout renders immediately; if loaders exist, the LoaderBoundary becomes
    // the outlet content so layout's <Outlet /> suspends until loaders resolve.
    result = (
      <OutletProvider
        content={hasOwnLoaders ? loaderWrapped : content}
        segment={segment}
      >
        {segment.layout}
      </OutletProvider>
    );
  } else if (hasOwnLoaders) {
    // No layout but has loaders — wrap content with LoaderBoundary for useLoader context.
    // Common for intercept routes that use useLoader without a custom layout.
    result = loaderWrapped;
  } else {
    result = content;
  }

  if (segment.mountPath) {
    return (
      <MountContextProvider value={segment.mountPath}>
        {result}
      </MountContextProvider>
    );
  }

  return result;
}

function useSlotSegment(
  context: OutletContextValue | null,
  name: `@${string}` | undefined,
): ResolvedSegment | null {
  return useMemo(() => {
    if (!name || !context?.parallel) return null;
    return context.parallel.find((seg) => seg.slot === name) ?? null;
  }, [context, name]);
}

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
 * For a named slot, `<Outlet name="@x" />` is equivalent to
 * `<ParallelOutlet name="@x" />` — both run the same resolution + wrapping
 * pipeline. Convention: use bare `<Outlet />` for default content and
 * `<ParallelOutlet name="@x" />` for named slots.
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
  const namedSegment = useSlotSegment(context, name);

  if (name) {
    return renderSlotContent(namedSegment);
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
 * Equivalent to `<Outlet name="@x" />` for a named slot; ParallelOutlet
 * requires `name` and is named-slot-only, which reads clearer at the call site.
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
  const segment = useSlotSegment(context, name);

  return renderSlotContent(segment);
}

// OutletProvider is defined in outlet-provider.tsx to break a circular
// dependency between client.tsx and route-content-wrapper.tsx. It is imported
// at the top of this file for local use in Outlet/ParallelOutlet only; it is an
// internal component and is intentionally not part of the public ./client API.

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

export {
  useLoader,
  useFetchLoader,
  useRefreshLoaders,
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

export { useNavigation } from "./browser/react/use-navigation.js";
export { useRouter } from "./browser/react/use-router.js";
export { usePathname } from "./browser/react/use-pathname.js";
export { useSearchParams } from "./browser/react/use-search-params.js";
export { useParams } from "./browser/react/use-params.js";
export type {
  RouterInstance,
  RouterNavigateOptions,
  ReadonlyURLSearchParams,
  ActionState,
  ActionLifecycleState,
} from "./browser/types.js";

export {
  useAction,
  type ServerActionFunction,
} from "./browser/react/use-action.js";

export {
  useSegments,
  type SegmentsState,
} from "./browser/react/use-segments.js";

export {
  NavigationProvider,
  type NavigationProviderProps,
} from "./browser/react/NavigationProvider.js";

export {
  Link,
  type LinkProps,
  type PrefetchStrategy,
  type StateOrGetter,
  type LinkState,
} from "./browser/react/Link.js";

export {
  useLinkStatus,
  type LinkStatus,
} from "./browser/react/use-link-status.js";

export {
  ScrollRestoration,
  useScrollRestoration,
  type ScrollRestorationProps,
} from "./browser/react/ScrollRestoration.js";

export { type Handle } from "./handle.js";
export { useHandle } from "./browser/react/use-handle.js";
// Type a deferred-aware consumer narrows: an accumulated entry may be a Promise
// (a `ctx.use(Handle).defer()` slot) until it resolves.
export type { DeferredHandleEntry } from "./defer.js";

export { Meta } from "./handles/meta.js";
export { MetaTags } from "./handles/MetaTags.js";
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";
export { Breadcrumbs, type BreadcrumbItem } from "./handles/breadcrumbs.js";

export {
  createLocationState,
  useLocationState,
  type LocationStateDefinition,
  type LocationStateEntry,
  type LocationStateOptions,
} from "./browser/react/location-state.js";

// Ambient Rango.Path / Rango.PathResponse types (declared in href-client.ts)
export { href, type PatternToPath } from "./href-client.js";

// RFC 9457 error type for JSON response routes
export type { ProblemDetails } from "./urls.js";

export { useMount } from "./browser/react/use-mount.js";
export { MountContext } from "./browser/react/mount-context.js";

export { useHref } from "./browser/react/use-href.js";

export { useReverse } from "./browser/react/use-reverse.js";

export type { ScopedReverseFunction, LocalReverseFunction } from "./reverse.js";

export type { LoaderDefinition } from "./types.js";
