import type { ReactNode } from "react";
import type {
  DefaultEnv,
  ExtractRouteParams,
  Handler,
  HandlersForRouteMap,
  LoaderDefinition,
  LoaderFn,
  MiddlewareFn,
  ResolvedRouteMap,
  RouteDefinition,
  ShouldRevalidateFn,
} from "./types.js";
import { getContext, type EntryData } from "./server/context";
import { invariant } from "./errors";
import RootLayout from "./server/root-layout";
import type {
  AllUseItems,
  LayoutItem,
  RouteItem,
  ParallelItem,
  MiddlewareItem,
  RevalidateItem,
  LoaderItem,
  LoadingItem,
  LayoutUseItem,
  RouteUseItem,
  ParallelUseItem,
  LoaderUseItem,
} from "./route-types.js";
// const __DEV__ = import.meta.MODE === "development";
/**
 * Define routes or get a route key
 */
export function route<const T extends RouteDefinition>(
  input: T
): ResolvedRouteMap<T> {
  return flattenRoutes(input as RouteDefinition, "") as ResolvedRouteMap<T>;
}

/**
 * Flatten nested route definitions
 */
function flattenRoutes(
  routes: RouteDefinition,
  prefix: string
): Record<string, string> {
  const flattened: Record<string, string> = {};

  for (const [key, value] of Object.entries(routes)) {
    if (typeof value === "string") {
      // Direct route pattern - include prefix
      flattened[prefix + key] = value;
    } else {
      // Nested routes - flatten recursively
      const nested = flattenRoutes(value, `${prefix}${key}.`);
      Object.assign(flattened, nested);
    }
  }

  return flattened;
}

// Type definitions moved to route-types.ts to avoid bundling in client code
// Re-export for backward compatibility within this module
export type {
  AllUseItems,
  LayoutItem,
  RouteItem,
  ParallelItem,
  MiddlewareItem,
  RevalidateItem,
  LoaderItem,
  LayoutUseItem,
  RouteUseItem,
  ParallelUseItem,
} from "./route-types.js";

/**
 * Route helpers provided by map()
 * These are the only typed helpers users interact with
 */
export type RouteHelpers<T extends RouteDefinition, TEnv> = {
  route: <K extends keyof ResolvedRouteMap<T> & string>(
    name: K,
    handler: Handler<ExtractRouteParams<T, K & string>, TEnv>,
    use?: () => RouteUseItem[]
  ) => RouteItem;
  layout: (
    component: ReactNode | Handler<any, TEnv>,
    use?: () => LayoutUseItem[]
  ) => LayoutItem;
  parallel: <
    TSlots extends Record<`@${string}`, Handler<any, TEnv> | ReactNode>
  >(
    slots: TSlots,
    use?: () => ParallelUseItem[]
  ) => ParallelItem;
  middleware: (...fns: MiddlewareFn<any, TEnv>[]) => MiddlewareItem;
  revalidate: (fn: ShouldRevalidateFn<any, TEnv>) => RevalidateItem;
  loader: <TData>(
    loaderDef: LoaderDefinition<TData>,
    use?: () => LoaderUseItem[]
  ) => LoaderItem;
  loading: (component: ReactNode) => LoadingItem;
};

const revalidate: RouteHelpers<any, any>["revalidate"] = (fn) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("revalidate() must be called inside map()");

  // Attach to last entry in stack
  if (!ctx.parent || !ctx.parent?.revalidate) {
    invariant(false, "No parent entry available for revalidate()");
  }
  const name = `$${getContext().getNextIndex("revalidate")}`;
  ctx.parent.revalidate.push(fn);
  return { name, type: "revalidate" } as RevalidateItem;
};

const middleware: RouteHelpers<any, any>["middleware"] = (...fn) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("middleware() must be called inside map()");

  // Attach to last entry in stack
  if (!ctx.parent || !ctx.parent?.middleware) {
    invariant(false, "No parent entry available for middleware()");
  }
  const name = `$${getContext().getNextIndex("middleware")}`;
  ctx.parent.middleware.push(...fn);
  return { name, type: "middleware" } as MiddlewareItem;
};

const parallel: RouteHelpers<any, any>["parallel"] = (slots, use) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("parallel() must be called inside map()");

  if (!ctx.parent || !ctx.parent?.parallel) {
    invariant(false, "No parent entry available for parallel()");
  }

  const namespace = `${ctx.namespace}.$${store.getNextIndex("parallel")}`;

  // Create full EntryData for parallel with its own loaders/revalidate/loading
  const entry = {
    id: namespace,
    shortCode: store.getShortCode("parallel"),
    type: "parallel",
    parent: null, // Parallels don't participate in parent chain traversal
    handler: slots,
    middleware: [],
    revalidate: [],
    layout: [],
    parallel: [],
    loader: [],
  } satisfies EntryData;

  // Run use callback if provided to collect loaders, revalidate, loading
  if (use && typeof use === "function") {
    const result = store.run(namespace, entry, use);
    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `parallel() use() callback must return an array of use items [${namespace}]`
    );
  }

  ctx.parent.parallel.push(entry);
  return { name: namespace, type: "parallel" } as ParallelItem;
};

/**
 * Loader helper - attaches a loader to the current entry
 */
const loaderFn: RouteHelpers<any, any>["loader"] = (loaderDef, use) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("loader() must be called inside map()");

  // Attach to last entry in stack
  if (!ctx.parent || !ctx.parent?.loader) {
    invariant(false, "No parent entry available for loader()");
  }

  const name = `${ctx.namespace}.$${store.getNextIndex("loader")}`;

  // Create loader entry with empty revalidate array
  const loaderEntry = {
    loader: loaderDef,
    revalidate: [] as ShouldRevalidateFn<any, any>[],
  };

  // If use() callback provided, run it to collect revalidation rules
  if (use && typeof use === "function") {
    // Temporarily set context for revalidate() calls to target this loader
    const originalParent = ctx.parent;
    // Create a temporary "parent" that has the revalidate array we want to populate
    const tempParent = {
      ...originalParent,
      revalidate: loaderEntry.revalidate,
    };
    ctx.parent = tempParent as EntryData;

    const result = use();

    // Restore original parent
    ctx.parent = originalParent;

    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `loader() use() callback must return an array of use items [${name}]`
    );
  }

  ctx.parent.loader.push(loaderEntry);
  return { name, type: "loader" } as LoaderItem;
};

/**
 * Loading helper - attaches a loading component to the current entry
 * Loading components are static (no context) and shown during navigation
 */
const loadingFn: RouteHelpers<any, any>["loading"] = (component) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("loading() must be called inside map()");

  if (!ctx.parent) {
    invariant(false, "No parent entry available for loading()");
  }

  // Attach loading component to parent entry
  ctx.parent.loading = component;

  const name = `$${store.getNextIndex("loading")}`;
  return { name, type: "loading" } as LoadingItem;
};

const routeFn: RouteHelpers<any, any>["route"] = (name, handler, use) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("route() must be called inside map()");

  const namespace = `${ctx.namespace}.${store.getNextIndex("route")}.${name}`;

  const entry = {
    id: namespace,
    shortCode: store.getShortCode("route"),
    type: "route",
    parent: ctx.parent,
    handler,
    middleware: [],
    revalidate: [],
    layout: [],
    parallel: [],
    loader: [],
  } satisfies EntryData;

  /* We will throw if user is registring same route name twice */
  invariant(
    ctx.manifest.get(name) === undefined,
    `Duplicate route name: ${name} at ${namespace}`
  );
  /* Register route entry */
  ctx.manifest.set(name, entry);
  /* Run use and attach handlers */
  if (use && typeof use === "function") {
    const result = store.run(namespace, entry, use);
    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `route() use() callback must return an array of use items [${namespace}]`
    );
    return { name: namespace, type: "route", uses: result } as RouteItem;
  }

  /* typesafe item */
  return { name: namespace, type: "route" } as RouteItem;
};

const layout: RouteHelpers<any, any>["layout"] = (handler, use) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("layout() must be called inside map()");
  const isRoot = !ctx.parent || ctx.parent === null;
  const namespace = `${ctx.namespace}.${
    isRoot ? "$root" : store.getNextIndex("layout")
  }`;

  const entry = {
    id: namespace,
    shortCode: store.getShortCode("layout"),
    type: "layout",
    parent: ctx.parent,
    handler,
    middleware: [],
    revalidate: [],
    parallel: [],
    layout: [],
    loader: [],
  } satisfies EntryData;

  // Run use callback if provided
  let result: AllUseItems[] | undefined;
  if (use && typeof use === "function") {
    result = store.run(namespace, entry, use);

    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `layout() use() callback must return an array of use items [${namespace}]`
    );
  }

  // Check if this is an orphan layout (no routes in children)
  const hasRoutes =
    result &&
    Array.isArray(result) &&
    result.some((item) => item.type === "route");

  if (!hasRoutes) {
    const parent = ctx.parent;

    // Allow orphan layouts at root level if they're part of map() builder result
    if (!parent || parent === null) {
      if (!isRoot) {
        invariant(
          false,
          `Orphan layout cannot be used at non-root level without parent [${namespace}]`
        );
      }
      // Root-level orphan is allowed (e.g., sibling layouts in map() builder)
    } else {
      // Has parent - register as orphan layout
      invariant(
        parent.type === "route" || parent.type === "layout",
        `Orphan layouts can only be defined inside route or layout > check [${namespace}]`
      );

      // Clear parent pointer for orphan layouts to prevent duplicate processing
      entry.parent = null;
      parent.layout.push(entry);
    }
  }

  if (result) {
    return { name: namespace, type: "layout", uses: result } as LayoutItem;
  }
  return {
    name: namespace,
    type: "layout",
  } as LayoutItem;
};

const isValidUseItem = (item: any): item is AllUseItems | undefined | null => {
  return (
    typeof item === "undefined" ||
    item === null ||
    (item &&
      typeof item === "object" &&
      "type" in item &&
      [
        "layout",
        "route",
        "middleware",
        "revalidate",
        "parallel",
        "loader",
        "loading",
      ].includes(item.type))
  );
};

const isOrphanLayout = (item: AllUseItems): boolean => {
  return (
    item.type === "layout" &&
    !item.uses?.some(
      (item) =>
        item.type === "route" ||
        (item.type === "layout" && !isOrphanLayout(item))
    )
  );
};

/*
 * Create revalidate helper
 */
const createRevalidateHelper = <TEnv>(): RouteHelpers<
  any,
  TEnv
>["revalidate"] => {
  return revalidate as RouteHelpers<any, TEnv>["revalidate"];
};

/**
 * Create middleware helper
 */
const createMiddlewareHelper = <TEnv>(): RouteHelpers<
  any,
  TEnv
>["middleware"] => {
  return middleware as RouteHelpers<any, TEnv>["middleware"];
};

/**
 * Create middleware helper
 */
const createParallelHelper = <TEnv>(): RouteHelpers<any, TEnv>["parallel"] => {
  return parallel as RouteHelpers<any, TEnv>["parallel"];
};

/**
 * Create loader helper
 */
const createLoaderHelper = <TEnv>(): RouteHelpers<any, TEnv>["loader"] => {
  return loaderFn as RouteHelpers<any, TEnv>["loader"];
};

/**
 * Create loading helper
 */
const createLoadingHelper = (): RouteHelpers<any, any>["loading"] => {
  return loadingFn;
};

/**
 * Create route helper
 */
const createRouteHelper = <
  const T extends RouteDefinition,
  TEnv
>(): RouteHelpers<T, TEnv>["route"] => {
  return routeFn as RouteHelpers<T, TEnv>["route"];
};

/**
 * Create layout helper
 */
const createLayoutHelper = <TEnv>(): RouteHelpers<any, TEnv>["layout"] => {
  return layout as RouteHelpers<any, TEnv>["layout"];
};

/**
 * Type-safe handler definition helper
 *
 */
export function map<const T extends RouteDefinition, TEnv = DefaultEnv>(
  builder: (helpers: RouteHelpers<T, TEnv>) => Array<AllUseItems>
): () => Array<AllUseItems> {
  return () => {
    // Check if it's a builder function (array-based API)
    invariant(
      typeof builder === "function",
      "map() expects a builder function as its argument"
    );
    // Create helpers
    const helpers: RouteHelpers<T, TEnv> = {
      route: createRouteHelper<T, TEnv>(),
      layout: createLayoutHelper<TEnv>(),
      parallel: createParallelHelper<TEnv>(),
      middleware: createMiddlewareHelper<TEnv>(),
      revalidate: createRevalidateHelper<TEnv>(),
      loader: createLoaderHelper<TEnv>(),
      loading: createLoadingHelper(),
    };

    return [layout(RootLayout, () => builder(helpers))].flat(3);
  };
}

/**
 * Create a loader definition
 *
 * Loaders are RSC-compatible data fetchers that:
 * - Run after middleware, before handlers
 * - Are scoped to where attached (layout/route subtree)
 * - Revalidate independently from UI segments
 * - Are memoized per request (multiple ctx.use() calls return same value)
 *
 * Use the `"use server"` directive inside the loader function to ensure
 * the function is stripped from client bundles.
 *
 * Return type is automatically inferred from the callback.
 *
 * @param name - Unique identifier for the loader (used for client-side lookup)
 * @param fn - Async function that fetches data (should contain "use server" directive)
 *
 * @example
 * ```typescript
 * // loaders/cart.ts - return type inferred from callback
 * export const CartLoader = createLoader("cart", async (ctx) => {
 *   "use server";
 *   const user = ctx.get("user");
 *   return await db.cart.get(user.id); // Return type inferred!
 * });
 *
 * // loaders/product.ts - return type inferred
 * export const ProductLoader = createLoader("product", async (ctx) => {
 *   "use server";
 *   const { slug } = ctx.params;
 *   return await db.products.findBySlug(slug); // Return type inferred!
 * });
 *
 * // Usage in handlers
 * layout(<ShopLayout />, () => [
 *   loader(CartLoader),
 *   loader(CartLoader, () => [
 *     revalidate(({ action }) => action === "cart:update"),
 *   ]),
 * ])
 *
 * // Server-side access
 * route("cart", (ctx) => {
 *   const cart = ctx.use(CartLoader);
 *   return <CartPage cart={cart} />;
 * });
 *
 * // Client-side access
 * const cart = useLoader(CartLoader);
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

// Implementation
export function createLoader(
  name: string,
  fn?: LoaderFn<any, Record<string, string | undefined>, any>
): LoaderDefinition<any, Record<string, string | undefined>> {
  return {
    __brand: "loader",
    name,
    fn,
  };
}

/**
 * Create a soft redirect Response for middleware short-circuit
 *
 * Returns a Response that signals a client-side navigation to the target URL.
 * Unlike Response.redirect() which causes a full page reload, this redirect
 * is handled by the router for SPA-style navigation.
 *
 * @param url - The URL to redirect to
 * @param status - HTTP status code (default: 302)
 *
 * @example
 * ```typescript
 * middleware((ctx, next) => {
 *   if (!ctx.get('user')) {
 *     return redirect('/login');
 *   }
 *   next();
 * })
 * ```
 */
export function redirect(url: string, status: number = 302): Response {
  return new Response(null, {
    status,
    headers: {
      Location: url,
      "X-RSC-Redirect": "soft",
    },
  });
}
