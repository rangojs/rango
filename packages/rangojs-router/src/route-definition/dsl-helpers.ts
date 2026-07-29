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
  requireDslContext,
  stampStaticDefScope,
  type EntryData,
  type EntryPropDatas,
  type EntryPropSegments,
  type HelperContext,
  type InterceptEntry,
  type InterceptConfig,
  type LoaderEntry,
} from "../server/context";
import { invariant } from "../errors";
import { validateUserRouteName } from "../route-name.js";
import { isCachedFunction } from "../cache/taint.js";
import { RangoContext } from "../server/context";
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
  CacheItem,
  TransitionItem,
  UseItems,
} from "../route-types.js";
import type { RouteHelpers } from "./helpers-types.js";
import { resolveHandlerUse, mergeHandlerUse } from "./resolve-handler-use.js";
import { ALL_USE_ITEM_TYPES } from "./use-item-types.js";

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

/**
 * Fresh empty collections shared by every from-scratch segment entry. Returns
 * new arrays/objects per call so no two entries share mutable references.
 * mountPath is intentionally NOT included here — each call site adds it from
 * getUrlPrefix() where applicable: the route() and transition() helpers add
 * none, while path() (which also builds a `type: "route"` entry) and the
 * structural helpers (layout/cache/middleware/parallel) do.
 */
const emptySegmentBase = (): EntryPropDatas &
  EntryPropSegments & { loading: undefined } => ({
  loading: undefined,
  middleware: [],
  revalidate: [],
  errorBoundary: [],
  notFoundBoundary: [],
  layout: [],
  parallel: {},
  intercept: [],
  loader: [],
});

/**
 * Run a children/use callback as a nested scope, flatten the result, and assert
 * every item is a valid use item. `kind` preserves the existing error wording
 * ("use()" vs "children" callback).
 */
function runAndValidateUseItems(
  store: ReturnType<typeof getContext>,
  namespace: string,
  entry: EntryData,
  cb: () => any,
  label: string,
  kind: "use" | "children",
): AllUseItems[] {
  const result = store.run(namespace, entry, cb)?.flat(3);
  return validateUseItems(result, namespace, label, kind);
}

/** Assert an already-invoked, flattened callback result is a use-item array. */
function validateUseItems(
  result: any,
  namespace: string,
  label: string,
  kind: "use" | "children",
): AllUseItems[] {
  invariant(
    Array.isArray(result) && result.every((item) => isValidUseItem(item)),
    `${label}() ${kind === "use" ? "use()" : "children"} callback must return an array of use items [${namespace}]`,
  );
  return result as AllUseItems[];
}

/** True when a children/use result contains no routes (directly or nested). */
const isOrphan = (result: AllUseItems[]): boolean =>
  !result.some((item) => item != null && hasRoutesInItem(item));

/**
 * Register a routeless structural entry as an orphan sibling: clear its parent
 * pointer so it leaves the middleware/parent-pointer chain (LOAD-BEARING — see
 * docs/tree-structure.md) and push it onto the parent's layout[] so it renders
 * as a wrapper. Used by cache()/middleware()/transition(); layout() runs extra
 * validation and registers inline.
 */
const attachOrphanSibling = (
  parent: EntryData | null,
  entry: EntryData,
): void => {
  entry.parent = null;
  if (parent && "layout" in parent) parent.layout.push(entry);
};

/**
 * Run `fn` with `ctx.parent` temporarily redirected to `temp` — a satellite
 * entry that captures the attachments declared by a use() callback — restoring
 * the original parent afterward, including on throw. loader()/intercept() each
 * build their own tempParent shape (intercept keeps a loading get/set accessor
 * and a captured-layouts array); this only centralizes the save/restore.
 */
function withParent<T>(ctx: HelperContext, temp: EntryData, fn: () => T): T {
  const original = ctx.parent;
  ctx.parent = temp;
  try {
    return fn();
  } finally {
    ctx.parent = original;
  }
}

const revalidate: RouteHelpers<any, any>["revalidate"] = (fn) => {
  const { store, ctx } = requireDslContext(
    "revalidate() must be called inside urls()",
  );

  // Attach to last entry in stack
  const parent = ctx.parent;
  if (!parent || !("revalidate" in parent)) {
    invariant(false, "No parent entry available for revalidate()");
  }
  const name = `$${store.getNextIndex("revalidate")}`;
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
  const { store, ctx } = requireDslContext(
    "errorBoundary() must be called inside urls()",
  );

  // Attach to parent entry in stack
  const parent = ctx.parent;
  if (!parent || !("errorBoundary" in parent)) {
    invariant(false, "No parent entry available for errorBoundary()");
  }
  const name = `$${store.getNextIndex("errorBoundary")}`;
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
  const { store, ctx } = requireDslContext(
    "notFoundBoundary() must be called inside urls()",
  );

  // Attach to parent entry in stack
  const parent = ctx.parent;
  if (!parent || !("notFoundBoundary" in parent)) {
    invariant(false, "No parent entry available for notFoundBoundary()");
  }
  const name = `$${store.getNextIndex("notFoundBoundary")}`;
  parent.notFoundBoundary.push(fallback);
  return { name, type: "notFoundBoundary" } as NotFoundBoundaryItem;
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
 * - cache({ ttl: 60 }, () => [...]) - with explicit options
 *
 * Named cache profiles are applied via the `"use cache: <profile>"` directive,
 * not a `cache("profileName")` form in the route tree.
 */
const cache: RouteHelpers<any, any>["cache"] = (
  optionsOrChildren?:
    | PartialCacheOptions
    | false
    | (() => UseItems<AllUseItems>),
  maybeChildren?: () => UseItems<AllUseItems>,
) => {
  const { store, ctx } = requireDslContext(
    "cache() must be called inside urls()",
  );

  // Handle overloaded signature
  let options: PartialCacheOptions | false;
  let children: (() => UseItems<AllUseItems>) | undefined;

  if (optionsOrChildren === undefined) {
    // cache() - no args, use defaults
    options = {};
    children = undefined;
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
    const urlPrefix = getUrlPrefix();

    const entry = {
      ...emptySegmentBase(),
      id: namespace,
      shortCode: store.getShortCode("cache"),
      type: "cache",
      parent: parent, // link to current parent for hierarchy
      cache: cacheConfig,
      handler: RootLayout,
      ...(urlPrefix ? { mountPath: urlPrefix } : {}),
    } satisfies EntryData;

    // Attach to parent's layout array (cache entries are structural like layouts)
    if (parent && "layout" in parent) {
      parent.layout.push(entry);
    }

    // Update context parent so subsequent siblings attach to this cache entry
    // This makes cache() act as sugar for cache(() => [...])
    ctx.parent = entry;

    return { name: namespace, type: "cache" } as CacheItem;
  }

  // Inside a loader() use() callback, only the direct form — cache()/cache(opts)
  // — writes cache config to the loader entry. The wrapper form creates a
  // structural cache boundary with its own children scope, which has no effect
  // on the loader and would silently no-op.
  invariant(
    !(ctx.parent && (ctx.parent as any).type === "loader"),
    "cache() wrapper form is not valid inside loader() use(). Use cache({...}) without children to configure the loader's cache.",
  );

  // With children: create a cache entry (like layout with caching semantics)
  const namespace = `${ctx.namespace}.${cacheIndex}`;
  const cacheShortCode = store.getShortCode("cache");

  const urlPrefix = getUrlPrefix();

  const entry = {
    ...emptySegmentBase(),
    id: namespace,
    shortCode: cacheShortCode,
    type: "cache",
    parent: ctx.parent,
    cache: cacheConfig,
    // Cache entries render like layouts (with Outlet as default handler)
    handler: RootLayout, // RootLayout just renders <Outlet />
    ...(urlPrefix ? { mountPath: urlPrefix } : {}),
  } satisfies EntryData;

  // Run children with cache entry as parent
  const result = runAndValidateUseItems(
    store,
    namespace,
    entry,
    children,
    "cache",
    "children",
  );

  // Cache entries are structural like layouts: with no routes inside, register
  // as an orphan sibling.
  if (isOrphan(result)) attachOrphanSibling(ctx.parent, entry);

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

  const { store, ctx } = requireDslContext(
    "middleware() must be called inside urls()",
  );

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
    ...emptySegmentBase(),
    id: namespace,
    shortCode: store.getShortCode("layout"),
    type: "layout",
    parent: ctx.parent,
    handler: RootLayout,
    middleware: [...fns],
    ...(urlPrefix ? { mountPath: urlPrefix } : {}),
  } satisfies EntryData;

  // Run children callback. If the second arg was actually a middleware fn
  // (old variadic form: middleware(mw1, mw2)), this will return a non-array
  // and the invariant below gives a clear migration error.
  const rawResult = store.run(namespace, entry, children);

  invariant(
    Array.isArray(rawResult),
    "middleware(fn, children) expects the second argument to return an array of use items. " +
      "To pass multiple middleware, use middleware([fn1, fn2]).",
  );

  const result = validateUseItems(
    rawResult.flat(3),
    namespace,
    "middleware",
    "children",
  );

  if (isOrphan(result)) attachOrphanSibling(ctx.parent, entry);

  return {
    name: namespace,
    type: "middleware",
    uses: result,
  } as MiddlewareItem;
};

// Slot names become part of segment ids: a parallel/intercept slot is encoded
// as `${shortCode}.${slotName}`, and loader segments append `D${index}.${loaderId}`.
// A "." in the slot name collides with that separator -- loaderParentId
// (segment-system.tsx) strips from the FIRST `D<index>.`, so a name like
// "@D3.foo" is mis-cut to "@" and the loader's data is silently dropped. Reject
// the dot at definition time so the failure is loud, not a corrupted tree at
// runtime. (A bare "D" without a trailing dot -- e.g. "@Detail" -- is fine.)
function assertValidSlotName(slotName: string): void {
  invariant(
    !slotName.includes("."),
    `Slot name "${slotName}" must not contain ".". The dot is a reserved ` +
      `segment-id separator; a name like "@D3.foo" corrupts loader segment-id ` +
      `parsing and silently drops the loader's data. Rename the slot.`,
  );
}

const parallel: RouteHelpers<any, any>["parallel"] = (slots, use) => {
  const { store, ctx } = requireDslContext(
    "parallel() must be called inside urls()",
  );

  if (!ctx.parent || !ctx.parent?.parallel) {
    invariant(false, "No parent entry available for parallel()");
  }

  invariant(
    ctx.parent.type !== "parallel",
    "parallel() cannot be nested inside another parallel()",
  );

  const slotNames = Object.keys(slots as Record<string, any>) as `@${string}`[];
  for (const slotName of slotNames) assertValidSlotName(slotName);

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
        stampStaticDefScope(slotHandler);
      }
    } else {
      unwrappedSlots[slotName] = slotHandler;
    }
  }

  // Create full EntryData for parallel with its own loaders/revalidate/loading
  const parallelUrlPrefix = getUrlPrefix();
  const entry = {
    ...emptySegmentBase(),
    id: namespace,
    shortCode: store.getShortCode("parallel"),
    type: "parallel",
    parent: null, // Parallels don't participate in parent chain traversal
    handler: unwrappedSlots,
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
      runAndValidateUseItems(
        store,
        namespace,
        slotEntry,
        slotMergedUse,
        "parallel",
        "use",
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
  configOrUse?: InterceptConfig | (() => any[]),
  use?: () => any[],
) => {
  // arg4 discrimination: a function is the use() callback (no config); an object
  // is the config carrying `when`. With config given, the use() callback is
  // arg5. Keeps the no-config form intercept(slot, route, handler, () => [...])
  // working unchanged.
  const config: InterceptConfig | undefined =
    typeof configOrUse === "function" || configOrUse == null
      ? undefined
      : configOrUse;
  const useFn = typeof configOrUse === "function" ? configOrUse : use;

  const { store, ctx } = requireDslContext(
    "intercept() must be called inside urls()",
  );

  if (!ctx.parent || !ctx.parent?.intercept) {
    invariant(false, "No parent entry available for intercept()");
  }

  invariant(
    ctx.parent.type !== "parallel",
    "intercept() cannot be used inside parallel()",
  );

  assertValidSlotName(slotName);

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

  // Conditional interception: `when` from the config object — a single selector
  // or an array (ALL must return true to activate). Replaces the former when()
  // use-item captured inside the callback.
  if (config?.when) {
    const selectors = Array.isArray(config.when) ? config.when : [config.when];
    entry.when.push(...selectors);
  }

  // Merge handler.use defaults with explicit use
  const handlerUseFn = resolveHandlerUse(handler);
  const mergedUse = mergeHandlerUse(handlerUseFn, useFn, "intercept");

  // Run merged use callback to collect loaders, revalidate, middleware, etc.
  if (mergedUse) {
    // Capture layout() calls into a temporary array
    const capturedLayouts: EntryData[] = [];

    // Temporary parent so middleware/loader/revalidate/when attach to the
    // intercept entry; the loading get/set accessor mirrors writes onto `entry`.
    const tempParent = {
      ...ctx.parent,
      middleware: entry.middleware,
      revalidate: entry.revalidate,
      errorBoundary: entry.errorBoundary,
      notFoundBoundary: entry.notFoundBoundary,
      loader: entry.loader,
      layout: capturedLayouts, // Capture layout() calls
      get loading() {
        return entry.loading;
      },
      set loading(value: ReactNode | false | undefined) {
        entry.loading = value;
      },
    };

    const result = withParent(ctx, tempParent as EntryData, () =>
      mergedUse()?.flat(3),
    );

    // Extract layout from captured layouts (use first one if multiple)
    // Layout inside intercept should always be ReactNode or Handler, not Record slots
    if (capturedLayouts.length > 0 && capturedLayouts[0].type === "layout") {
      entry.layout = capturedLayouts[0].handler as
        | ReactNode
        | Handler<any, any, any>;
    }

    validateUseItems(result, namespace, "intercept", "use");
  }

  ctx.parent.intercept.push(entry);
  return { name: namespace, type: "intercept" } as InterceptItem;
};

/**
 * Loader helper - attaches a loader to the current entry
 */
const loader: RouteHelpers<any, any>["loader"] = (
  loaderDef,
  optionsOrUse,
  maybeUse,
) => {
  const { store, ctx } = requireDslContext(
    "loader() must be called inside urls()",
  );

  // Attach to last entry in stack
  if (!ctx.parent || !ctx.parent?.loader) {
    invariant(false, "No parent entry available for loader()");
  }

  // loader(Def, use) and loader(Def, options, use) — same options-or-use
  // disambiguation path() uses, so the long-standing 2-arg form is untouched.
  const optionsGiven =
    typeof optionsOrUse === "function" ? undefined : optionsOrUse;
  const use = typeof optionsOrUse === "function" ? optionsOrUse : maybeUse;
  invariant(
    !(typeof optionsOrUse === "function" && maybeUse !== undefined),
    "loader() received two use() callbacks. Pass loader(Def, options, use) or loader(Def, use).",
  );
  invariant(
    (optionsGiven as { stream?: unknown } | undefined)?.stream === undefined,
    "loader() stream was replaced: use loader(Def, { ssr: false }) — the same knob as loading(fallback, { ssr: false }) — to await the loader before first flush on document requests.",
  );
  invariant(
    optionsGiven?.ssr === undefined || typeof optionsGiven.ssr === "boolean",
    `loader() ssr must be a boolean (got ${JSON.stringify(optionsGiven?.ssr)}). Omit it (or pass true) to stream on every render.`,
  );

  const name = `${ctx.namespace}.$${store.getNextIndex("loader")}`;

  // Create loader entry with empty revalidate array. awaitBeforeFlush is
  // resolved here, at DSL-evaluation time, for the same reason
  // loading({ ssr: false }) is (below) — per-isSSR entry caching makes the
  // flag request-mode-correct with no isSSR threading; see LoaderEntry.
  const loaderEntry: LoaderEntry = {
    loader: loaderDef,
    revalidate: [] as ShouldRevalidateFn<any, any>[],
    ...(optionsGiven?.ssr === false && ctx.isSSR
      ? { awaitBeforeFlush: true as const }
      : {}),
  };

  // Merge handler.use defaults (attached to the loader definition) with explicit use
  const handlerUseFn = resolveHandlerUse(loaderDef);
  const mergedUse = mergeHandlerUse(handlerUseFn, use, "loader");

  // If any use callback is in effect, run it to collect revalidation rules and cache config
  if (mergedUse) {
    // Create a temporary "parent" with type "loader" so cache() can detect it.
    // Save existing .cache to distinguish inherited config from newly set config.
    const parentCache = (ctx.parent as any).cache;
    const tempParent = {
      ...ctx.parent,
      type: "loader",
      revalidate: loaderEntry.revalidate,
    };

    const result = withParent(ctx, tempParent as EntryData, () =>
      mergedUse()?.flat(3),
    );

    // Copy cache config only if cache() was called during the use() callback.
    // The spread may carry an inherited .cache from a parent cache() boundary —
    // only copy if it was newly set.
    if (
      (tempParent as any).cache &&
      (tempParent as any).cache !== parentCache
    ) {
      (loaderEntry as any).cache = (tempParent as any).cache;
    }

    validateUseItems(result, name, "loader", "use");
  }

  ctx.parent.loader.push(loaderEntry);
  return { name, type: "loader" } as LoaderItem;
};

/**
 * Loading helper - attaches a loading component to the current entry
 * Loading components are static (no context) and shown during navigation
 */
const loading: RouteHelpers<any, any>["loading"] = (component, options) => {
  const { store, ctx } = requireDslContext(
    "loading() must be called inside urls()",
  );

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
 * Transition helper - opts the entry (or a wrapped group of routes) into
 * transition-driven navigation by attaching a TransitionConfig. This drives the
 * commit through startTransition (content hold on all React versions) and, on
 * experimental React, places a `<ViewTransition>` boundary unless
 * `viewTransition: false`. See skills/view-transitions for the matrix.
 */
const transition = (
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

  const { store, ctx } = requireDslContext(
    "transition() must be called inside urls()",
  );

  // Allocate a single index for this transition() call (used in all paths),
  // mirroring cache() — the child form uses it for the name, the wrapper form
  // reuses it for the namespace, so no index is burned.
  const transitionIndex = store.getNextIndex("transition");
  const name = `$${transitionIndex}`;

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
  const namespace = `${ctx.namespace}.${transitionIndex}`;
  const entry = {
    ...emptySegmentBase(),
    id: namespace,
    shortCode: store.getShortCode("layout"),
    type: "layout",
    parent: ctx.parent,
    handler: RootLayout,
    transition: config,
  } satisfies EntryData;

  const result = runAndValidateUseItems(
    store,
    namespace,
    entry,
    children,
    "transition",
    "children",
  );

  if (isOrphan(result)) attachOrphanSibling(ctx.parent, entry);

  return { name: namespace, type: "transition" } as TransitionItem;
};

const route: RouteHelpers<any, any>["route"] = (name, handler, use) => {
  const { store, ctx } = requireDslContext(
    "route() must be called inside urls()",
  );

  // Reject names colliding with reserved internal prefixes ($path_, $prefix_),
  // the same guard path() and include() enforce. Without it such a name
  // type-checks on an untyped router, then silently vanishes from generated
  // route-types and public reverse() (isAutoGeneratedRouteName filters it out).
  validateUserRouteName(name);

  const namespace = `${ctx.namespace}.${store.getNextIndex("route")}.${name}`;

  const entry = {
    ...emptySegmentBase(),
    id: namespace,
    shortCode: store.getShortCode("route"),
    type: "route",
    parent: ctx.parent,
    handler: handler as unknown as Handler<any, any, any>,
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
    const result = runAndValidateUseItems(
      store,
      namespace,
      entry,
      mergedUse,
      "route",
      "use",
    );
    return { name: namespace, type: "route", uses: result } as RouteItem;
  }

  /* typesafe item */
  return { name: namespace, type: "route" } as RouteItem;
};

const layout: RouteHelpers<any, any>["layout"] = (handler, use) => {
  const { store, ctx } = requireDslContext(
    "layout() must be called inside urls()",
  );

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
    ...emptySegmentBase(),
    id: namespace,
    shortCode,
    type: "layout",
    parent: ctx.parent,
    handler: unwrappedHandler,
    ...(urlPrefix ? { mountPath: urlPrefix } : {}),
    ...(isStatic
      ? {
          isStaticPrerender: true as const,
          ...(handler.$$id ? { staticHandlerId: handler.$$id } : {}),
        }
      : {}),
  } satisfies EntryData;

  // Capture namespace prefix on static handler for build-time reverse() resolution
  if (isStatic && handler.$$id) {
    if (ctx.namePrefix) {
      (handler as any).$$routePrefix = ctx.namePrefix;
    }
    stampStaticDefScope(handler);
  }

  // Merge handler.use defaults with explicit use
  const handlerUseFn = resolveHandlerUse(handler);
  const mergedUse = mergeHandlerUse(handlerUseFn, use, "layout");

  // Run merged use callback if present
  let result: AllUseItems[] | undefined;
  if (mergedUse) {
    result = runAndValidateUseItems(
      store,
      namespace,
      entry,
      mergedUse,
      "layout",
      "use",
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

      attachOrphanSibling(parent, entry);
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

const isValidUseItem = (item: any): item is AllUseItems | undefined | null =>
  item == null ||
  (typeof item === "object" &&
    "type" in item &&
    ALL_USE_ITEM_TYPES.has(item.type));

// DSL helpers exported for direct import from @rangojs/router and for
// assembly into the RouteHelpers object in helper-factories.ts. The route-item
// types are discriminated by their `type` literal, so the helpers carry no brand.
export {
  layout,
  cache,
  middleware,
  revalidate,
  parallel,
  intercept,
  errorBoundary,
  notFoundBoundary,
  route,
  loader,
  loading,
  transition,
  isValidUseItem,
  emptySegmentBase,
  runAndValidateUseItems,
};
