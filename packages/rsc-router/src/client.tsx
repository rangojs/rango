"use client";

import { useContext, useMemo, Suspense, type ReactNode } from "react";
import { OutletContext, type OutletContextValue } from "./outlet-context.js";
import type { LoaderDefinition, LoaderFn, ResolvedSegment } from "./types";

/**
 * Outlet component - renders child content in layouts
 *
 * If the current segment defines a loading component, the outlet content
 * is wrapped in Suspense with the loading component as fallback.
 * This means during navigation/streaming, React's Suspense will automatically
 * show the loading skeleton until the content is ready.
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
 * ```
 */
export function Outlet(): ReactNode {
  const context = useContext(OutletContext);
  const content = context?.content ?? null;

  // If this segment defines a loading component, wrap outlet content with Suspense
  // The loading component becomes the Suspense fallback, shown during streaming/navigation
  if (context?.loading) {
    return (
      <Suspense fallback={context.loading}>
        {content}
      </Suspense>
    );
  }

  return content;
}
/**
 * ParallelOutlet component - renders content for a named parallel slot
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
  return useMemo(() => {
    if (!context?.parallel) return null;
    const segment = context.parallel.find((seg) => seg.slot === name);
    return segment?.component ?? null;
  }, [context, name]);
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
