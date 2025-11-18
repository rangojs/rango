import type { ReactNode } from "react";
import type {
  DefaultEnv,
  ExtractRouteParams,
  Handler,
  HandlersForRouteMap,
  MiddlewareFn,
  ResolvedRouteMap,
  RouteDefinition,
  ShouldRevalidateFn,
} from "./types.js";
import { getContext, type EntryData } from "./server/context";
import { invariant } from "./errors";
import RootLayout from "./server/root-layout";
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

/**
 * Branded return types for route helpers
 */
export declare const LayoutBrand: unique symbol;
export declare const RouteBrand: unique symbol;
export declare const ParallelBrand: unique symbol;
export declare const MiddlewareBrand: unique symbol;
export declare const RevalidateBrand: unique symbol;
export declare const LoaderBrand: unique symbol;

export type LayoutItem = { name: string; type: "layout"; [LayoutBrand]: void };
export type RouteItem = { name: string; type: "route"; [RouteBrand]: void };
export type ParallelItem = {
  name: string;
  type: "parallel";
  [ParallelBrand]: void;
};
export type LoaderItem = { name: string; type: "loader"; [LoaderBrand]: void };
export type MiddlewareItem = {
  name: string;
  type: "middleware";
  [MiddlewareBrand]: void;
};
export type RevalidateItem = {
  name: string;
  type: "revalidate";
  [RevalidateBrand]: void;
};

/**
 * Union types for use() callbacks
 */
export type AllUseItems =
  | LayoutItem
  | RouteItem
  | MiddlewareItem
  | RevalidateItem
  | ParallelItem
  | LoaderItem;
export type LayoutUseItem =
  | LayoutItem
  | RouteItem
  | MiddlewareItem
  | RevalidateItem
  | ParallelItem
  | LoaderItem;
export type RouteUseItem =
  | ParallelItem
  | MiddlewareItem
  | RevalidateItem
  | LoaderItem;
export type ParallelUseItem = MiddlewareItem | RevalidateItem | LoaderItem;

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
};

const revalidate: RouteHelpers<any, any>["revalidate"] = (fn) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("revalidate() must be called inside map()");

  // Attach to last entry in stack
  if (!ctx.parent || !ctx.parent?.revalidate) {
    invariant(false, "No parent entry available for revalidate()");
  }
  const name = `$${getContext().getNameForType("revalidate")}`;
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
  const name = `$${getContext().getNameForType("middleware")}`;
  ctx.parent.middleware.push(...fn);
  return { name, type: "middleware" } as MiddlewareItem;
};

const parallel: RouteHelpers<any, any>["parallel"] = (slots) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("parallel() must be called inside map()");

  // Attach to last entry in stack
  if (!ctx.parent || !ctx.parent?.parallel) {
    invariant(false, "No parent entry available for parallel()");
  }
  const name = `$${getContext().getNameForType("parallel")}`;
  ctx.parent.parallel.push(slots);
  return { name, type: "parallel" } as ParallelItem;
};

const routeFn: RouteHelpers<any, any>["route"] = (name, handler, use) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("route() must be called inside map()");

  const namespace = store.getNameForType("route") + `.${name}`;

  const entry = {
    id: namespace,
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
    `Duplicate route name: ${name}`
  );
  /* Register route entry */
  ctx.manifest.set(name, entry);
  /* Run use and attach handlers */
  if (use && typeof use === "function") store.run(namespace, entry, use);

  /* typesafe item */
  return { name: namespace, type: "route" } as RouteItem;
};

const layout: RouteHelpers<any, any>["layout"] = (handler, use) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("route() must be called inside map()");

  const namespace = `$${store.getNameForType("layout")}`;

  const entry = {
    id: namespace,
    type: "layout",
    parent: ctx.parent,
    handler,
    middleware: [],
    revalidate: [],
    parallel: [],
    layout: [],
    loader: [],
  } satisfies EntryData;

  if (use && typeof use === "function") {
    const result = store.run(namespace, entry, use);
    if (
      result &&
      Array.isArray(result) &&
      result.some((item) => item.type === "route") === false
    ) {
      /* for easy narrowing */
      const parent = ctx.parent;
      // Orphan layout - extend parent
      invariant(
        parent || parent !== null,
        "Orphan layout cannot be used at root level"
      );

      invariant(
        parent.type === "route" || parent.type === "layout",
        "Orhant layouts can only be defined inside route or layout entries"
      );
      parent.layout.push(entry);
    }
  }

  return { name: namespace, type: "layout" } as LayoutItem;
};

/**
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
  builder: (
    helpers: RouteHelpers<T, TEnv>
  ) => Array<Exclude<AllUseItems, ParallelItem>>
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
    };

    const store = getContext().getOrCreateStore();
    const parent = store.parent;

    // Execute builder in AsyncLocalStorage context
    const node = getContext()
      // start with empty namespace and no parent
      .run("", parent, () =>
        parent ? builder(helpers) : [layout(RootLayout, () => builder(helpers))]
      );

    performance.mark("map-start");
    console.dir(node, { depth: null });
    console.log("manifest", store.manifest.entries());
    const perf = performance.measure("map", "map-start");
    console.log("perf", perf);

    return node;
  };
}
