import type { ReactNode } from "react";
import type {
  PartialCacheOptions,
  Handler,
  LoaderDefinition,
  MiddlewareFn,
  ShouldRevalidateFn,
  TransitionConfig,
} from "../types.js";
import {
  getContext,
  getNamePrefix,
  getUrlPrefix,
  type EntryData,
  type InterceptEntry,
} from "../server/context";
import { invariant } from "../errors";
import { isCachedFunction } from "../cache/taint.js";
import { RSCRouterContext } from "../server/context";
import { isStaticHandler } from "../static-handler.js";
import RootLayout from "../server/root-layout";
import type {
  AllUseItems,
  RouteItem,
  ParallelItem,
  InterceptItem,
  MiddlewareItem,
  RevalidateItem,
  LoaderItem,
  LoadingItem,
  ErrorBoundaryItem,
  NotFoundBoundaryItem,
  LayoutItem,
  WhenItem,
  CacheItem,
  TransitionItem,
  UseItems,
} from "../route-types.js";
import type { RouteHelpers } from "./helpers-types.js";
import { resolveHandlerUse, mergeHandlerUse } from "./resolve-handler-use.js";

/**
 * Check if an item contains routes (directly or inside nested structures like cache).
 * Used to determine if a layout or cache should be treated as an orphan.
 */
const hasRoutesInItem = (item: AllUseItems): boolean => {
  if (item.type === "route") return true;
  // Lazy includes contain deferred routes — treat them as having routes
  // to prevent the parent layout from being misclassified as orphan,
  // which would clear its parent pointer and break the middleware chain.
  if (item.type === "include") return true;
  if (item.type === "cache" && item.uses) {
    return item.uses.some((child) => hasRoutesInItem(child));
  }
  if (item.type === "layout" && item.uses) {
    return item.uses.some((child) => hasRoutesInItem(child));
  }
  if (item.type === "middleware" && item.uses) {
    return item.uses.some((child) => hasRoutesInItem(child));
  }
  return false;
};

const revalidate: RouteHelpers<any, any>["revalidate"] = (fn) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("revalidate() must be called inside map()");

  // Attach to last entry in stack
  const parent = ctx.parent;
  if (!parent || !("revalidate" in parent)) {
    invariant(false, "No parent entry available for revalidate()");
  }
  const name = `$${getContext().getNextIndex("revalidate")}`;
  parent.revalidate.push(fn);
  return { name, type: "revalidate" } as RevalidateItem;
};

/**
 * Error boundary helper - attaches an error fallback to the current entry
 *
 * When an error occurs during rendering of this segment or its children,
 * the fallback will be rendered instead. The fallback can be:
 * - A static ReactNode (e.g., <ErrorPage />)
 * - A handler function that receives error info and reset function
 *
 * Error boundaries catch errors from:
 * - Middleware execution
 * - Loader execution
 * - Handler/component rendering
 *
 * @example
 * ```typescript
 * layout(<ShopLayout />, () => [
 *   errorBoundary(<ShopErrorFallback />),
 *   route("products.detail", ProductDetail),
 * ])
 *
 * // Or with handler for dynamic error UI:
 * route("products.detail", ProductDetail, () => [
 *   errorBoundary(({ error, reset }) => (
 *     <div>
 *       <h2>Product failed to load</h2>
 *       <p>{error.message}</p>
 *       <button onClick={reset}>Retry</button>
 *     </div>
 *   )),
 * ])
 * ```
 */
const errorBoundary: RouteHelpers<any, any>["errorBoundary"] = (fallback) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("errorBoundary() must be called inside map()");

  // Attach to parent entry in stack
  const parent = ctx.parent;
  if (!parent || !("errorBoundary" in parent)) {
    invariant(false, "No parent entry available for errorBoundary()");
  }
  const name = `$${getContext().getNextIndex("errorBoundary")}`;
  parent.errorBoundary.push(fallback);
  return { name, type: "errorBoundary" } as ErrorBoundaryItem;
};

/**
 * NotFound boundary helper - attaches a not-found fallback to the current entry
 *
 * When a DataNotFoundError is thrown (via notFound()) during rendering of this
 * segment or its children, the fallback will be rendered instead. The fallback can be:
 * - A static ReactNode (e.g., <ProductNotFound />)
 * - A handler function that receives not found info
 *
 * NotFound boundaries catch DataNotFoundError from:
 * - Loader execution
 * - Handler/component rendering
 *
 * @example
 * ```typescript
 * layout(<ShopLayout />, () => [
 *   notFoundBoundary(<ProductNotFound />),
 *   route("products.detail", ProductDetail),
 * ])
 *
 * // Or with handler for dynamic not found UI:
 * route("products.detail", ProductDetail, () => [
 *   notFoundBoundary(({ notFound }) => (
 *     <div>
 *       <h2>Product not found</h2>
 *       <p>{notFound.message}</p>
 *       <a href="/products">Browse all products</a>
 *     </div>
 *   )),
 * ])
 * ```
 */
const notFoundBoundary: RouteHelpers<any, any>["notFoundBoundary"] = (
  fallback,
) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("notFoundBoundary() must be called inside map()");

  // Attach to parent entry in stack
  const parent = ctx.parent;
  if (!parent || !("notFoundBoundary" in parent)) {
    invariant(false, "No parent entry available for notFoundBoundary()");
  }
  const name = `$${getContext().getNextIndex("notFoundBoundary")}`;
  parent.notFoundBoundary.push(fallback);
  return { name, type: "notFoundBoundary" } as NotFoundBoundaryItem;
};

/**
 * When helper - defines a condition for intercept activation
 *
 * Only valid inside intercept() use() callback. The when() function
 * is captured by the intercept and stored in its `when` array.
 * During soft navigation, all when() conditions must return true
 * for the intercept to activate.
 */
const when: RouteHelpers<any, any>["when"] = (fn) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("when() must be called inside intercept()");

  // The when() function needs to be captured by the intercept's tempParent
  // which should have a `when` array. If not present, we're not inside intercept()
  const parent = ctx.parent as any;
  if (!parent || !("when" in parent)) {
    invariant(
      false,
      "when() can only be used inside intercept() use() callback",
    );
  }

  const name = `$${getContext().getNextIndex("when")}`;
  parent.when.push(fn);
  return { name, type: "when" } as WhenItem;
};

/**
 * Cache helper - defines caching configuration for segments
 *
 * Creates a cache boundary that applies to all children unless overridden.
 * When used without children, attaches cache config to the parent entry
 * (e.g., for loader-specific caching).
 *
 * Supports these call signatures:
 * - cache() - no args, uses app-level defaults (for loader caching)
 * - cache(() => [...]) - wraps children with app-level defaults
 * - cache('profileName') - uses a named cache profile
 * - cache('profileName', () => [...]) - named profile with children
 * - cache({ ttl: 60 }, () => [...]) - with explicit options
 */
const cache: RouteHelpers<any, any>["cache"] = (
  optionsOrChildren?:
    | PartialCacheOptions
    | false
    | string
    | (() => UseItems<AllUseItems>),
  maybeChildren?: () => UseItems<AllUseItems>,
) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("cache() must be called inside map()");

  // Handle overloaded signature
  let options: PartialCacheOptions | false;
  let children: (() => UseItems<AllUseItems>) | undefined;

  if (optionsOrChildren === undefined) {
    // cache() - no args, use defaults
    options = {};
    children = undefined;
  } else if (typeof optionsOrChildren === "string") {
    // cache('profileName') or cache('profileName', () => [...])
    // Resolve from context-scoped profiles (set per-router via HelperContext).
    const ctxStore = RSCRouterContext.getStore();
    const profile = ctxStore?.cacheProfiles?.[optionsOrChildren];
    invariant(
      profile,
      `cache("${optionsOrChildren}"): unknown cache profile. ` +
        `Define it in createRouter({ cacheProfiles: { "${optionsOrChildren}": { ttl: ... } } }).`,
    );
    options = { ttl: profile.ttl, swr: profile.swr, tags: profile.tags };
    children = maybeChildren;
  } else if (typeof optionsOrChildren === "function") {
    // cache(() => [...]) - use empty options (will use defaults)
    options = {};
    children = optionsOrChildren;
  } else {
    // cache(options, children) - explicit options
    options = optionsOrChildren;
    children = maybeChildren;
  }

  // Allocate a single index for this cache() call (used in all paths)
  const cacheIndex = store.getNextIndex("cache");
  const name = `$${cacheIndex}`;
  const cacheConfig = { options };

  // If no children, create an orphan cache entry (like orphan layouts)
  // This allows cache() to wrap subsequent siblings
  if (!children) {
    const parent = ctx.parent as any;

    // Check if we're inside a loader() use() callback - special case for loader caching
    if (parent && parent.type === "loader") {
      // Direct assignment to loader entry's cache field
      parent.cache = cacheConfig;
      return { name, type: "cache" } as CacheItem;
    }

    // Create orphan cache entry (like orphan layout)
    // Subsequent siblings in the same array will attach to this entry
    const namespace = `${ctx.namespace}.${cacheIndex}`;
    const cacheUrlPrefix = getUrlPrefix();

    const entry = {
      id: namespace,
      shortCode: store.getShortCode("cache"),
      type: "cache",
      parent: parent, // link to current parent for hierarchy
      cache: cacheConfig,
      handler: RootLayout,
      loading: undefined, // Allow loading() to attach loading state
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
      layout: [],
      parallel: {},
      intercept: [],
      loader: [],
      ...(cacheUrlPrefix ? { mountPath: cacheUrlPrefix } : {}),
    } as EntryData;

    // Attach to parent's layout array (cache entries are structural like layouts)
    if (parent && "layout" in parent) {
      parent.layout.push(entry);
    }

    // Update context parent so subsequent siblings attach to this cache entry
    // This makes cache() act as sugar for cache(() => [...])
    ctx.parent = entry;

    return { name: namespace, type: "cache" } as CacheItem;
  }

  // With children: create a cache entry (like layout with caching semantics)
  const namespace = `${ctx.namespace}.${cacheIndex}`;
  const cacheShortCode = store.getShortCode("cache");

  const cacheUrlPrefix2 = getUrlPrefix();

  const entry = {
    id: namespace,
    shortCode: cacheShortCode,
    type: "cache",
    parent: ctx.parent,
    cache: cacheConfig,
    // Cache entries render like layouts (with Outlet as default handler)
    handler: RootLayout, // RootLayout just renders <Outlet />
    loading: undefined, // Allow loading() to attach loading state
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: {},
    intercept: [],
    loader: [],
    ...(cacheUrlPrefix2 ? { mountPath: cacheUrlPrefix2 } : {}),
  } as EntryData;

  // Run children with cache entry as parent
  const result = store.run(namespace, entry, children)?.flat(3);

  invariant(
    Array.isArray(result) && result.every((item) => isValidUseItem(item)),
    `cache() children callback must return an array of use items [${namespace}]`,
  );

  // Check if this cache has routes (including nested caches/layouts)
  const hasRoutes =
    result &&
    Array.isArray(result) &&
    result.some((item) => hasRoutesInItem(item));

  if (!hasRoutes) {
    const parent = ctx.parent;
    if (parent && "layout" in parent) {
      // Attach to parent's layout array (cache entries are structural like layouts)
      entry.parent = null;
      parent.layout.push(entry);
    }
  }

  return { name: namespace, type: "cache", uses: result } as CacheItem;
};

const middleware: RouteHelpers<any, any>["middleware"] = (...args: any[]) => {
  // Four call forms:
  //   middleware(fn)                       — single fn, sibling
  //   middleware(fn, () => [...])          — single fn, wrapping
  //   middleware([fn1, fn2])              — array, sibling
  //   middleware([fn1, fn2], () => [...]) — array, wrapping
  const isArray = Array.isArray(args[0]);

  // Reject the removed variadic form before executing anything.
  // middleware(fn1, fn2, fn3) — 3+ args, always wrong.
  // middleware(fn1, fn2) where fn2 is a middleware fn (length >= 1), not a
  // children callback (length === 0) — legacy two-fn form, reject early.
  if (
    args.length > 2 ||
    (!isArray &&
      args.length === 2 &&
      typeof args[1] === "function" &&
      args[1].length > 0)
  ) {
    throw new Error(
      "middleware() no longer accepts variadic arguments. " +
        "Use middleware([fn1, fn2, ...]) instead of middleware(fn1, fn2, ...).",
    );
  }

  const fns: MiddlewareFn<any>[] = isArray ? args[0] : [args[0]];
  const children: (() => any[]) | undefined =
    typeof args[1] === "function" ? args[1] : undefined;

  // Prevent "use cache" functions from being used as middleware.
  for (const f of fns) {
    if (isCachedFunction(f)) {
      throw new Error(
        `A "use cache" function cannot be used as middleware. ` +
          `Cached functions return data and do not participate in the ` +
          `middleware chain. Remove the "use cache" directive or use a ` +
          `regular middleware function instead.`,
      );
    }
  }

  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("middleware() must be called inside map()");

  if (!children) {
    // Sibling mode: attach to parent entry
    const parent = ctx.parent;
    if (!parent || !("middleware" in parent)) {
      invariant(false, "No parent entry available for middleware()");
    }
    const name = `$${store.getNextIndex("middleware")}`;
    parent.middleware.push(...fns);
    return { name, type: "middleware" } as MiddlewareItem;
  }

  // Wrapping mode: create a transparent layout that carries the middleware
  const mwIndex = store.getNextIndex("middleware");
  const namespace = `${ctx.namespace}.${mwIndex}`;

  const urlPrefix = getUrlPrefix();
  const entry = {
    id: namespace,
    shortCode: store.getShortCode("layout"),
    type: "layout",
    parent: ctx.parent,
    handler: RootLayout,
    loading: undefined,
    middleware: [...fns],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: {},
    intercept: [],
    loader: [],
    ...(urlPrefix ? { mountPath: urlPrefix } : {}),
  } as EntryData;

  // Run children callback. If the second arg was actually a middleware fn
  // (old variadic form: middleware(mw1, mw2)), this will return a non-array
  // and the invariant below gives a clear migration error.
  const rawResult = store.run(namespace, entry, children);

  invariant(
    Array.isArray(rawResult),
    "middleware(fn, children) expects the second argument to return an array of use items. " +
      "To pass multiple middleware, use middleware([fn1, fn2]).",
  );

  const result = rawResult.flat(3);

  invariant(
    result.every((item: any) => isValidUseItem(item)),
    `middleware() children callback must return an array of use items [${namespace}]`,
  );

  const hasRoutes =
    result &&
    Array.isArray(result) &&
    result.some((item) => item != null && hasRoutesInItem(item));

  if (!hasRoutes) {
    const parent = ctx.parent;
    if (parent && "layout" in parent) {
      entry.parent = null;
      parent.layout.push(entry);
    }
  }

  return {
    name: namespace,
    type: "middleware",
    uses: result,
  } as MiddlewareItem;
};

const parallel: RouteHelpers<any, any>["parallel"] = (slots, use) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("parallel() must be called inside map()");

  if (!ctx.parent || !ctx.parent?.parallel) {
    invariant(false, "No parent entry available for parallel()");
  }

  invariant(
    ctx.parent.type !== "parallel",
    "parallel() cannot be nested inside another parallel()",
  );

  const slotNames = Object.keys(slots as Record<string, any>) as `@${string}`[];

  const namespace = `${ctx.namespace}.$${store.getNextIndex("parallel")}`;

  // Unwrap slot values. A slot value can be:
  //   - a Handler / ReactNode (legacy form)
  //   - a Static() definition (build-time only)
  //   - a slot descriptor `{ handler, use? }` for slot-local overrides
  // The descriptor's `use` runs after the broadcast `use` for that slot,
  // so single-assignment items like `loading()` placed there win without
  // affecting siblings.
  const unwrappedSlots: Record<string, any> = {};
  const slotLocalUses: Record<string, (() => any[]) | undefined> = {};
  let hasStaticSlot = false;
  const staticSlotIds: Record<string, string> = {};
  for (const [slotName, rawSlot] of Object.entries(
    slots as Record<string, any>,
  )) {
    let slotHandler: any = rawSlot;
    if (isSlotDescriptor(rawSlot)) {
      slotHandler = rawSlot.handler;
      slotLocalUses[slotName] = rawSlot.use;
    }
    if (isStaticHandler(slotHandler)) {
      hasStaticSlot = true;
      unwrappedSlots[slotName] = slotHandler.handler;
      if (slotHandler.$$id) {
        staticSlotIds[slotName] = slotHandler.$$id;
        // Capture namespace prefix for build-time reverse() resolution
        if (ctx.namePrefix) {
          (slotHandler as any).$$routePrefix = ctx.namePrefix;
        }
      }
    } else {
      unwrappedSlots[slotName] = slotHandler;
    }
  }

  // Create full EntryData for parallel with its own loaders/revalidate/loading
  const parallelUrlPrefix = getUrlPrefix();
  const entry = {
    id: namespace,
    shortCode: store.getShortCode("parallel"),
    type: "parallel",
    parent: null, // Parallels don't participate in parent chain traversal
    handler: unwrappedSlots,
    loading: undefined, // Allow loading() to attach loading state
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: {},
    intercept: [],
    loader: [],
    ...(parallelUrlPrefix ? { mountPath: parallelUrlPrefix } : {}),
    ...(hasStaticSlot
      ? {
          isStaticPrerender: true as const,
          ...(Object.keys(staticSlotIds).length > 0
            ? { staticHandlerIds: staticSlotIds }
            : {}),
        }
      : {}),
  } satisfies EntryData;

  for (const slotName of slotNames) {
    const slotEntry = {
      ...entry,
      handler: { [slotName]: unwrappedSlots[slotName]! },
      middleware: [...entry.middleware],
      revalidate: [...entry.revalidate],
      errorBoundary: [...entry.errorBoundary],
      notFoundBoundary: [...entry.notFoundBoundary],
      layout: [...entry.layout],
      parallel: { ...entry.parallel },
      intercept: [...entry.intercept],
      loader: [...entry.loader],
      ...(entry.staticHandlerIds?.[slotName]
        ? {
            isStaticPrerender: true as const,
            staticHandlerIds: { [slotName]: entry.staticHandlerIds[slotName]! },
          }
        : {
            isStaticPrerender: undefined,
            staticHandlerIds: undefined,
          }),
    } satisfies EntryData;

    // Per-slot merge order (narrowest-scope-wins for single-assignment items
    // like loading()):
    //   1. handler.use      — defaults baked into the handler
    //   2. shared `use`     — broadcast at the parallel() call site
    //   3. slot-local `use` — per-slot override via `{ handler, use }` descriptor
    // Items that accumulate (loader, middleware, revalidate, …) compose
    // across all three layers regardless of order.
    const rawSlot = (slots as Record<string, any>)[slotName];
    const slotHandlerForUse = isSlotDescriptor(rawSlot)
      ? rawSlot.handler
      : rawSlot;
    const slotHandlerUse = resolveHandlerUse(slotHandlerForUse);
    const slotLocalUse = slotLocalUses[slotName];
    const explicitUse = combineExplicitUses(use, slotLocalUse);
    const slotMergedUse = mergeHandlerUse(
      slotHandlerUse,
      explicitUse,
      "parallel",
    );
    if (slotMergedUse) {
      const result = store.run(namespace, slotEntry, slotMergedUse)?.flat(3);
      invariant(
        Array.isArray(result) && result.every((item) => isValidUseItem(item)),
        `parallel() use() callback must return an array of use items [${namespace}]`,
      );
    }

    ctx.parent.parallel[slotName] = slotEntry;
  }
  return { name: namespace, type: "parallel" } as ParallelItem;
};

function isSlotDescriptor(
  value: unknown,
): value is { handler: unknown; use?: () => any[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !("__brand" in value) &&
    "handler" in value &&
    typeof (value as any).handler !== "undefined"
  );
}

function combineExplicitUses(
  sharedUse: (() => any[]) | undefined,
  slotLocalUse: (() => any[]) | undefined,
): (() => any[]) | undefined {
  if (!sharedUse && !slotLocalUse) return undefined;
  if (!slotLocalUse) return sharedUse;
  if (!sharedUse) return slotLocalUse;
  return () => [...sharedUse(), ...slotLocalUse()];
}

/**
 * Intercept helper - defines an intercepting route for soft navigation
 */
const intercept = (
  slotName: `@${string}`,
  routeName: string,
  handler: any,
  use?: () => any[],
) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("intercept() must be called inside map()");

  if (!ctx.parent || !ctx.parent?.intercept) {
    invariant(false, "No parent entry available for intercept()");
  }

  invariant(
    ctx.parent.type !== "parallel",
    "intercept() cannot be used inside parallel()",
  );

  const namespace = `${ctx.namespace}.$${store.getNextIndex("intercept")}.${slotName}`;

  // Dot-prefixed = local (add include prefix), unprefixed = global (use as-is)
  const isLocal = typeof routeName === "string" && routeName.startsWith(".");
  const bareRouteName = isLocal ? routeName.slice(1) : routeName;
  const namePrefix = getNamePrefix();
  const prefixedRouteName =
    isLocal && namePrefix ? `${namePrefix}.${bareRouteName}` : bareRouteName;

  // Create intercept entry with its own loaders/revalidate/middleware/when
  const entry: InterceptEntry = {
    slotName: slotName as `@${string}`,
    routeName: prefixedRouteName,
    handler,
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    loader: [],
    when: [], // Selector conditions for conditional interception
  };

  // Merge handler.use defaults with explicit use
  const handlerUseFn = resolveHandlerUse(handler);
  const mergedUse = mergeHandlerUse(handlerUseFn, use, "intercept");

  // Run merged use callback to collect loaders, revalidate, middleware, etc.
  if (mergedUse) {
    // Create a temporary parent context for the use() callback
    // so that middleware, loader, revalidate attach to the intercept entry
    const originalParent = ctx.parent;

    // Capture layouts in a temporary array
    const capturedLayouts: EntryData[] = [];

    const tempParent = {
      ...originalParent,
      middleware: entry.middleware,
      revalidate: entry.revalidate,
      errorBoundary: entry.errorBoundary,
      notFoundBoundary: entry.notFoundBoundary,
      loader: entry.loader,
      layout: capturedLayouts, // Capture layout() calls
      when: entry.when, // Capture when() conditions
      // Use getter/setter to capture loading on the entry
      get loading() {
        return entry.loading;
      },
      set loading(value: ReactNode | false | undefined) {
        entry.loading = value;
      },
    };
    ctx.parent = tempParent as EntryData;

    const result = mergedUse()?.flat(3);

    // Restore original parent
    ctx.parent = originalParent;

    // Extract layout from captured layouts (use first one if multiple)
    // Layout inside intercept should always be ReactNode or Handler, not Record slots
    if (capturedLayouts.length > 0 && capturedLayouts[0].type === "layout") {
      entry.layout = capturedLayouts[0].handler as
        | ReactNode
        | Handler<any, any, any>;
    }

    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `intercept() use() callback must return an array of use items [${namespace}]`,
    );
  }

  ctx.parent.intercept.push(entry);
  return { name: namespace, type: "intercept" } as InterceptItem;
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

  // If use() callback provided, run it to collect revalidation rules and cache config
  if (use && typeof use === "function") {
    // Temporarily set context for revalidate()/cache() calls to target this loader
    const originalParent = ctx.parent;
    // Create a temporary "parent" with type "loader" so cache() can detect it.
    // Save existing .cache to distinguish inherited config from newly set config.
    const parentCache = (originalParent as any).cache;
    const tempParent = {
      ...originalParent,
      type: "loader",
      revalidate: loaderEntry.revalidate,
    };
    ctx.parent = tempParent as EntryData;

    const result = use()?.flat(3);

    // Copy cache config only if cache() was called during the use() callback.
    // The spread from originalParent may carry an inherited .cache from
    // a parent cache() boundary — only copy if it was newly set.
    if (
      (tempParent as any).cache &&
      (tempParent as any).cache !== parentCache
    ) {
      (loaderEntry as any).cache = (tempParent as any).cache;
    }

    // Restore original parent
    ctx.parent = originalParent;

    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `loader() use() callback must return an array of use items [${name}]`,
    );
  }

  ctx.parent.loader.push(loaderEntry);
  return { name, type: "loader" } as LoaderItem;
};

/**
 * Loading helper - attaches a loading component to the current entry
 * Loading components are static (no context) and shown during navigation
 */
const loadingFn: RouteHelpers<any, any>["loading"] = (component, options) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("loading() must be called inside map()");

  const parent = ctx.parent;
  if (!parent || !("loading" in parent)) {
    invariant(false, "No parent entry available for loading()");
  }

  // Unwrap function form: loading(() => <Skeleton />) → loading(<Skeleton />)
  const resolved =
    typeof component === "function" ? (component as () => any)() : component;

  // If ssr: false and we're in SSR, set loading to false
  if (options?.ssr === false && ctx.isSSR) {
    parent.loading = false;
  } else {
    parent.loading = resolved;
  }

  const name = `$${store.getNextIndex("loading")}`;
  return { name, type: "loading" } as LoadingItem;
};

/**
 * Transition helper - attaches a ViewTransition config to the current entry
 * or wraps a group of routes in a transparent layout with ViewTransition
 */
const transitionFn = (
  configOrChildren?: TransitionConfig | (() => UseItems<AllUseItems>),
  maybeChildren?: () => UseItems<AllUseItems>,
): TransitionItem => {
  // Resolve overloaded arguments:
  //   transition()                    -> config={}, children=undefined
  //   transition(config)              -> config=config, children=undefined
  //   transition(children)            -> config={}, children=children
  //   transition(config, children)    -> config=config, children=children
  const config: TransitionConfig =
    typeof configOrChildren === "function" ? {} : (configOrChildren ?? {});
  const children: (() => UseItems<AllUseItems>) | undefined =
    typeof configOrChildren === "function" ? configOrChildren : maybeChildren;

  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("transition() must be called inside map()");

  const name = `$${store.getNextIndex("transition")}`;

  if (!children) {
    // Position 1: child of path() — attach to parent entry
    const parent = ctx.parent;
    if (!parent || !("loading" in parent)) {
      invariant(false, "No parent entry available for transition()");
    }
    parent.transition = config;
    return { name, type: "transition" } as TransitionItem;
  }

  // Position 2: wrapper — create a transparent layout with transition config
  const namespace = `${ctx.namespace}.${store.getNextIndex("transition")}`;
  const entry = {
    id: namespace,
    shortCode: store.getShortCode("layout"),
    type: "layout",
    parent: ctx.parent,
    handler: RootLayout,
    loading: undefined,
    transition: config,
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: {},
    intercept: [],
    loader: [],
  } as EntryData;

  const result = store.run(namespace, entry, children)?.flat(3);

  invariant(
    Array.isArray(result) && result.every((item) => isValidUseItem(item)),
    `transition() children callback must return an array of use items [${namespace}]`,
  );

  const hasRoutes =
    result &&
    Array.isArray(result) &&
    result.some((item) => hasRoutesInItem(item));

  if (!hasRoutes) {
    const parent = ctx.parent;
    if (parent && "layout" in parent) {
      entry.parent = null;
      parent.layout.push(entry);
    }
  }

  return { name: namespace, type: "transition" } as TransitionItem;
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
    handler: handler as unknown as Handler<any, any, any>,
    loading: undefined, // Allow loading() to attach loading state
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: {},
    intercept: [],
    loader: [],
  } satisfies EntryData;

  /* We will throw if user is registring same route name twice */
  invariant(
    ctx.manifest.get(name) === undefined,
    `Duplicate route name: ${name} at ${namespace}`,
  );
  /* Register route entry */
  ctx.manifest.set(name, entry);
  /* Merge handler.use defaults with explicit use */
  const handlerUseFn = resolveHandlerUse(handler);
  const mergedUse = mergeHandlerUse(handlerUseFn, use, "route");
  /* Run use and attach handlers */
  if (mergedUse) {
    const result = store.run(namespace, entry, mergedUse)?.flat(3);
    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `route() use() callback must return an array of use items [${namespace}]`,
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

  invariant(
    !ctx.parent || ctx.parent.type !== "parallel",
    "layout() cannot be used inside parallel()",
  );

  const isRoot = !ctx.parent || ctx.parent === null;
  const nextIndex = isRoot ? "$root" : store.getNextIndex("layout");
  const namespace = `${ctx.namespace}.${nextIndex}`;
  const shortCode = store.getShortCode("layout");

  // Unwrap static handler definition, extract the actual handler function
  const isStatic = isStaticHandler(handler);
  const unwrappedHandler = isStatic ? handler.handler : handler;

  const urlPrefix = getUrlPrefix();
  const entry = {
    id: namespace,
    shortCode,
    type: "layout",
    parent: ctx.parent,
    handler: unwrappedHandler,
    loading: undefined, // Allow loading() to attach loading state
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    parallel: {},
    intercept: [],
    layout: [],
    loader: [],
    ...(urlPrefix ? { mountPath: urlPrefix } : {}),
    ...(isStatic
      ? {
          isStaticPrerender: true as const,
          ...(handler.$$id ? { staticHandlerId: handler.$$id } : {}),
        }
      : {}),
  } satisfies EntryData;

  // Capture namespace prefix on static handler for build-time reverse() resolution
  if (isStatic && handler.$$id && ctx.namePrefix) {
    (handler as any).$$routePrefix = ctx.namePrefix;
  }

  // Merge handler.use defaults with explicit use
  const handlerUseFn = resolveHandlerUse(handler);
  const mergedUse = mergeHandlerUse(handlerUseFn, use, "layout");

  // Run merged use callback if present
  let result: AllUseItems[] | undefined;
  if (mergedUse) {
    result = store.run(namespace, entry, mergedUse)?.flat(3);

    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `layout() use() callback must return an array of use items [${namespace}]`,
    );
  }

  // Check if this is an orphan layout (no routes in children, including nested caches)
  const hasRoutes =
    result &&
    Array.isArray(result) &&
    result.some((item) => hasRoutesInItem(item));

  if (!hasRoutes) {
    // Orphan layouts must not contain other layouts as children.
    // If we're here, all child layouts are also orphan (if any had routes,
    // hasRoutesInItem would have returned true). Nested orphan chains are
    // confusing — use sibling orphan layouts instead.
    if (result) {
      invariant(
        !result.some((item) => item?.type === "layout"),
        `orphan layout cannot contain other layouts as children [${namespace}]`,
      );
    }

    const parent = ctx.parent;

    // Allow orphan layouts at root level if they're part of map() builder result
    if (!parent || parent === null) {
      if (!isRoot) {
        invariant(
          false,
          `Orphan layout cannot be used at non-root level without parent [${namespace}]`,
        );
      }
      // Root-level orphan is allowed (e.g., sibling layouts in map() builder)
    } else {
      // Has parent - register as orphan layout
      invariant(
        parent.type === "route" ||
          parent.type === "layout" ||
          parent.type === "cache",
        `Orphan layouts can only be defined inside route or layout > check [${namespace}]`,
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
        "intercept",
        "loader",
        "loading",
        "errorBoundary",
        "notFoundBoundary",
        "when",
        "cache",
        "transition",
        "include", // For urls() include() helper
      ].includes(item.type))
  );
};

// Global helper exports for direct import from @rangojs/router
export {
  layout,
  cache,
  middleware,
  revalidate,
  parallel,
  intercept,
  when,
  errorBoundary,
  notFoundBoundary,
  loaderFn as loader,
  loadingFn as loading,
  transitionFn as transition,
};

const isOrphanLayout = (item: AllUseItems): boolean => {
  return (
    item.type === "layout" &&
    !item.uses?.some((child) => hasRoutesInItem(child))
  );
};

// Internal exports used by helper-factories.ts
export {
  routeFn,
  loaderFn,
  loadingFn,
  transitionFn,
  hasRoutesInItem,
  isValidUseItem,
  isOrphanLayout,
};
