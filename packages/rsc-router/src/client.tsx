"use client";

import {
  Component,
  createElement,
  useContext,
  useMemo,
  Suspense,
  use,
  type ReactNode,
} from "react";
import { OutletContext, type OutletContextValue } from "./outlet-context.js";
import { OutletContextV2 } from "./outlet-context-v2.js";
import { SegmentStoreContext } from "./browser/react/segment-context.js";
import {
  type ClientErrorBoundaryFallbackProps,
  type ErrorInfo,
  type LoaderDefinition,
  type LoaderFn,
  type ResolvedSegment,
  isLoaderDataResult,
} from "./types";
import { RouteContentWrapper, LoaderBoundary } from "./route-content-wrapper.js";
import type { SegmentStore } from "./browser/segment-store.js";
import { useSegment, useSegmentNotification } from "./browser/react/use-segment.js";

/**
 * V2 implementation of Outlet using segment store subscriptions
 * This is used when SegmentStoreContext and OutletContextV2 are available
 */
function OutletV2Impl({
  segmentStore,
  segmentId,
  name,
}: {
  segmentStore: SegmentStore;
  segmentId: string;
  name?: `@${string}`;
}): ReactNode {
  // Subscribe to the current segment - use useSegmentNotification to always
  // force re-render when notified (including when child segments change).
  // useSegment would skip updates when segment data hasn't changed, but we
  // need to re-render to call getChildSegment() and get the new child.
  useSegmentNotification(segmentId);

  // Get segment data directly from store (re-render is already forced by notification)
  const segment = segmentStore.get(segmentId);

  console.log("[OutletV2Impl] Render:", {
    segmentId,
    name,
    hasSegment: !!segment,
    segmentType: segment?.type,
  });

  // For named slots, render parallel segment
  if (name) {
    const { parallels } = segmentStore.getChildren(segmentId);
    console.log("[OutletV2Impl] Looking for parallel:", {
      segmentId,
      name,
      parallelsCount: parallels.length,
      parallelSlots: parallels.map((p) => ({ id: p.id, slot: p.slot })),
    });
    const parallelSegment = parallels.find((p) => p.slot === name);

    if (!parallelSegment) {
      console.log("[OutletV2Impl] No parallel found for slot:", name);
      return null;
    }

    // Render via ParallelRendererV2 which subscribes to the parallel segment
    return <ParallelRendererV2 segment={parallelSegment} />;
  }

  // Default outlet - render child segment
  if (!segment) return null;

  const childSegment = segmentStore.getChildSegment(segmentId);
  console.log("[OutletV2Impl] Child segment:", {
    parentId: segmentId,
    childId: childSegment?.id,
    childType: childSegment?.type,
    storeIds: segmentStore.getIds(),
  });

  if (!childSegment) return null;

  // Render child with its own OutletProviderV2
  const childContent = <SegmentRendererV2 segment={childSegment} />;

  // If this segment has a loading component, wrap child in Suspense
  if (segment.loading) {
    return <Suspense fallback={segment.loading}>{childContent}</Suspense>;
  }

  return childContent;
}

/**
 * V2 implementation of ParallelOutlet using segment store subscriptions
 */
function ParallelOutletV2Impl({
  segmentStore,
  segmentId,
  name,
}: {
  segmentStore: SegmentStore;
  segmentId: string;
  name: `@${string}`;
}): ReactNode {
  // Subscribe to parent segment to re-render when notified (e.g., when parallel changes)
  useSegmentNotification(segmentId);

  const { parallels } = segmentStore.getChildren(segmentId);
  console.log("[ParallelOutletV2Impl] Render:", {
    segmentId,
    name,
    parallelsCount: parallels.length,
    parallelSlots: parallels.map((p) => ({ id: p.id, slot: p.slot })),
  });

  const parallelSegment = parallels.find((p) => p.slot === name);

  if (!parallelSegment) {
    console.log("[ParallelOutletV2Impl] No parallel found for slot:", name);
    return null;
  }

  // Render via ParallelRendererV2 which subscribes to the parallel segment
  return <ParallelRendererV2 segment={parallelSegment} />;
}

/**
 * Renders a segment's component with proper Suspense/loader handling (V2)
 * Subscribes to the segment so it re-renders when the segment data changes
 */
function SegmentRendererV2({ segment: initialSegment }: { segment: ResolvedSegment }): ReactNode {
  // Subscribe to this segment to re-render when it changes
  const segment = useSegment(initialSegment.id);
  const { id, component, loading, params, type, belongsToRoute } = segment || initialSegment;

  // Build key for this segment
  const includeParams =
    type === "route" ||
    type === "error" ||
    type === "notFound" ||
    (type === "layout" && belongsToRoute);

  const paramStr =
    includeParams && params && Object.keys(params).length > 0
      ? Object.entries(params)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join(",")
      : "";
  const key = paramStr ? `${id}-${paramStr}` : id;

  // Determine component content
  let nodeContent: ReactNode;
  if (loading || loading === null || component instanceof Promise) {
    nodeContent = createElement(RouteContentWrapper, {
      key: `suspense-loading-${id}`,
      content:
        component instanceof Promise ? component : Promise.resolve(component),
      fallback: loading,
    });
  } else {
    nodeContent = component;
  }

  // Wrap in OutletContextV2 for nested outlets
  return (
    <OutletContextV2.Provider key={key} value={{ segmentId: id }}>
      {nodeContent}
    </OutletContextV2.Provider>
  );
}

/**
 * Renders a parallel segment with subscription (V2)
 * Subscribes to the segment so it re-renders when the parallel data changes
 */
function ParallelRendererV2({ segment: initialSegment }: { segment: ResolvedSegment }): ReactNode {
  // Subscribe to this parallel segment to re-render when it changes
  const segment = useSegment(initialSegment.id);
  const parallelSegment = segment || initialSegment;

  // Determine content to render
  let content: ReactNode;
  if (parallelSegment.loading || parallelSegment.component instanceof Promise) {
    content = (
      <RouteContentWrapper
        content={
          parallelSegment.component instanceof Promise
            ? parallelSegment.component
            : Promise.resolve(parallelSegment.component)
        }
        fallback={parallelSegment.loading}
      />
    );
  } else {
    content = parallelSegment.component ?? null;
  }

  // If segment has a layout, wrap with OutletContextV2
  if (parallelSegment.layout) {
    if (parallelSegment.loaderDataPromise && parallelSegment.loaderNames) {
      return (
        <OutletContextV2.Provider value={{ segmentId: parallelSegment.id }}>
          <LoaderBoundary
            loaderDataPromise={parallelSegment.loaderDataPromise}
            loaderNames={parallelSegment.loaderNames}
            fallback={parallelSegment.loading}
            outletKey={parallelSegment.id + "-loader"}
            outletContent={content}
            segment={parallelSegment}
          >
            {parallelSegment.layout}
          </LoaderBoundary>
        </OutletContextV2.Provider>
      );
    }

    return (
      <OutletContextV2.Provider value={{ segmentId: parallelSegment.id }}>
        {parallelSegment.layout}
      </OutletContextV2.Provider>
    );
  }

  return content;
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
  // Check if we're in V2 mode (segment store based)
  const segmentStore = useContext(SegmentStoreContext);
  const v2Context = useContext(OutletContextV2);

  console.log("[Outlet] Render:", {
    name,
    hasSegmentStore: !!segmentStore,
    hasV2Context: !!v2Context,
    v2SegmentId: v2Context?.segmentId,
  });

  // V2 mode: Use segment store
  if (segmentStore && v2Context) {
    return <OutletV2Impl segmentStore={segmentStore} segmentId={v2Context.segmentId} name={name} />;
  }

  // V1 mode: Use outlet context
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
      if (segment.loaderDataPromise && segment.loaderNames) {
        const loaderAwareContent = (
          <LoaderBoundary
            loaderDataPromise={segment.loaderDataPromise}
            loaderNames={segment.loaderNames}
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
  // Check if we're in V2 mode (segment store based)
  const segmentStore = useContext(SegmentStoreContext);
  const v2Context = useContext(OutletContextV2);

  console.log("[ParallelOutlet] Render:", {
    name,
    hasSegmentStore: !!segmentStore,
    hasV2Context: !!v2Context,
    v2SegmentId: v2Context?.segmentId,
  });

  // V2 mode: Use segment store
  if (segmentStore && v2Context) {
    return (
      <ParallelOutletV2Impl
        segmentStore={segmentStore}
        segmentId={v2Context.segmentId}
        name={name}
      />
    );
  }

  // V1 mode: Use outlet context
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
      />
    );
  } else {
    content = segment.component ?? null;
  }

  // If segment has a layout, wrap appropriately
  if (segment.layout) {
    // Check if this segment has loaders that need streaming
    // The layout renders immediately, LoaderBoundary becomes the outlet content
    if (segment.loaderDataPromise && segment.loaderNames) {
      const loaderAwareContent = (
        <LoaderBoundary
          loaderDataPromise={segment.loaderDataPromise}
          loaderNames={segment.loaderNames}
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

  return content;
}

/**
 * Provider for outlet content - used internally by renderSegments
 *
 * Stores a reference to parent context so useLoader can walk up the chain
 * to find loader data from parent layouts. If this segment defines a loading
 * component, Outlet will wrap content with Suspense using that as fallback.
 */
export function OutletProvider({
  content,
  parallel,
  segment,
  loaderData,
  children,
}: {
  content: ReactNode;
  parallel?: ResolvedSegment[];
  segment?: ResolvedSegment;
  loaderData?: Record<string, any>;
  children: ReactNode;
}): ReactNode {
  // Get parent context to enable walking up the chain for loader lookups
  const parentContext = useContext(OutletContext);

  const value = useMemo(
    () => ({
      content,
      parallel,
      segment,
      loaderData,
      parent: parentContext,
      loading: segment?.loading,
    }),
    [content, parallel, segment, loaderData, parentContext]
  );

  return (
    <OutletContext.Provider value={value}>{children}</OutletContext.Provider>
  );
}

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

/**
 * Hook to access loader data on the client
 *
 * Loaders are server-only data fetchers. Their data is passed to the client
 * via RSC payload and made available through this hook.
 *
 * The loader must be attached to the current layout/route or a parent layout
 * to be accessible via this hook. The hook walks up the context chain to find
 * the loader data.
 *
 * @param loader - The loader definition (from createLoader())
 * @returns The loader's data, or undefined if not available
 *
 * @example
 * ```tsx
 * // loaders/cart.ts
 * export const CartLoader = createLoader("cart", async (ctx) => {
 *   "use server";
 *   const user = ctx.get("user");
 *   return await db.cart.get(user.id);
 * });
 *
 * // components/CartIcon.tsx (client component)
 * "use client";
 * import { useLoader } from "rsc-router/client";
 * import { CartLoader } from "../loaders/cart";
 *
 * export function CartIcon() {
 *   const cart = useLoader(CartLoader);
 *   return <span>Cart ({cart?.items.length ?? 0})</span>;
 * }
 * ```
 */
export function useLoader<T>(loader: LoaderDefinition<T>): T {
  // Check if we're in V2 mode (segment store based)
  const segmentStore = useContext(SegmentStoreContext);
  const v2Context = useContext(OutletContextV2);

  // V2 mode: look up loader data from segment store
  if (segmentStore && v2Context) {
    let currentId: string | undefined = v2Context.segmentId;

    console.log("[useLoader] V2 mode, looking for:", loader.name, "starting at:", currentId);

    while (currentId) {
      const { loaders } = segmentStore.getChildren(currentId);

      console.log("[useLoader] Checking segment:", currentId, "loaders:", loaders.map(l => ({
        id: l.id,
        loaderName: l.loaderName,
        hasData: l.loaderData !== undefined,
      })));

      // Check if any loader matches
      for (const loaderSegment of loaders) {
        if (loaderSegment.loaderName === loader.name) {
          let data = loaderSegment.loaderData;
          console.log("[useLoader] Found loader:", loader.name, "data:", data, "type:", typeof data);

          // Handle ReactPromise from RSC (has status, value, reason properties)
          if (data && typeof data === "object" && "status" in data) {
            const reactPromise = data as { status: string; value: unknown; reason: unknown };
            console.log("[useLoader] ReactPromise status:", reactPromise.status, "value:", reactPromise.value);
            if (reactPromise.status === "fulfilled") {
              data = reactPromise.value;
            } else if (reactPromise.status === "rejected") {
              throw reactPromise.reason;
            } else {
              // Status is "pending" - use() to suspend
              return use(data as Promise<T>);
            }
          }

          // If data is a standard promise, unwrap it with use()
          if (data instanceof Promise || (data && typeof data === "object" && "then" in data)) {
            return use(data as Promise<T>);
          }

          // Handle LoaderDataResult wrapper
          if (isLoaderDataResult(data)) {
            console.log("[useLoader] LoaderDataResult:", data);
            if (data.ok) {
              return data.data as T;
            } else {
              throw new Error(data.error.message);
            }
          }

          return data as T;
        }
      }

      // Walk up: find parent segment ID
      // "M9L0L1" → "M9L0", "M9L0R1" → "M9L0"
      const match: RegExpMatchArray | null = currentId.match(/^(.+)[LRD]\d+$/);
      const nextId: string | undefined = match?.[1];
      console.log("[useLoader] Walking up:", currentId, "->", nextId);
      currentId = nextId;
    }

    console.log("[useLoader] Not found, throwing error");
    throw new Error(
      `Loader data for "${loader.name}" not found. Make sure the loader is attached to this route or a parent layout.`
    );
  }

  // V1 mode: use outlet context
  const context = useContext(OutletContext);

  // Walk up the context chain to find this loader's data
  let current: OutletContextValue | null | undefined = context;
  while (current) {
    if (current.loaderData && loader.name in current.loaderData) {
      return current.loaderData[loader.name] as T;
    }
    current = current.parent;
  }

  throw new Error(
    `Loader data for "${loader.name}" not found in current outlet context. Make sure the loader is attached to this route or a parent layout.`
  );
}

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
  // Check if we're in V2 mode (segment store based)
  const segmentStore = useContext(SegmentStoreContext);
  const v2Context = useContext(OutletContextV2);

  // V2 mode: collect loader data from segment store
  if (segmentStore && v2Context) {
    const result: Record<string, any> = {};
    const visited = new Set<string>();

    // Walk from current segment up to root, collecting loader data
    let currentId: string | undefined = v2Context.segmentId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const { loaders } = segmentStore.getChildren(currentId);

      for (const loaderSegment of loaders) {
        if (loaderSegment.loaderName && loaderSegment.loaderData !== undefined) {
          // Don't override child loaders with parent loaders
          if (!(loaderSegment.loaderName in result)) {
            result[loaderSegment.loaderName] = loaderSegment.loaderData;
          }
        }
      }

      // Walk up: find parent segment ID
      // "M9L0L1" → "M9L0", "M9L0R1" → "M9L0"
      const match: RegExpMatchArray | null = currentId.match(/^(.+)[LRD]\d+$/);
      currentId = match?.[1];
    }

    return result;
  }

  // V1 mode: use outlet context
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
 * This is the client-side version that only stores the name - the function
 * is ignored since loaders only execute on the server.
 *
 * Use this when you need to reference a loader in a client component
 * without importing the server-side loader file.
 *
 * @param name - Unique name for the loader (must match server loader name)
 * @param _fn - Ignored on client (kept for API compatibility with server version)
 *
 * @example
 * ```tsx
 * "use client";
 * import { useLoader, createLoader } from "rsc-router/client";
 *
 * // Re-create loader definition client-side with matching name
 * const CartLoader = createLoader<Cart>("cart");
 *
 * export function CartIcon() {
 *   const cart = useLoader(CartLoader);
 *   return <span>Cart ({cart?.items.length ?? 0})</span>;
 * }
 * ```
 */
// Overload 1: With function, infer return type
export function createLoader<T>(
  name: string,
  fn: LoaderFn<T, Record<string, string | undefined>, any>
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 2: No function (client-side reference only)
export function createLoader(
  name: string
): LoaderDefinition<any, Record<string, string | undefined>>;

// Implementation - function is ignored at runtime on client
export function createLoader(
  name: string,
  _fn?: LoaderFn<any, Record<string, string | undefined>, any>
): LoaderDefinition<any, Record<string, string | undefined>> {
  return {
    __brand: "loader",
    name,
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

// V2: Segment-based rendering (subscription model)
// These exports use the new architecture where components subscribe to
// specific segments rather than receiving all data via context.
export {
  Outlet as OutletV2,
  OutletProviderV2,
  useLoaderV2,
  useLoaderDataV2,
} from "./client-v2.js";
