import type { ComponentType, ReactNode } from "react";
import { validateUserRouteName } from "../route-name.js";
import { buildRouteTrie } from "../router/route-trie-builder.js";
import { tryTrieMatch } from "../router/trie-matching.js";
import type { LoaderDefinition } from "../types.js";
import type {
  ClientPathOptions,
  ClientRevalidateFn,
  ClientTransitionConfig,
  ClientUrlBuilder,
  ClientUrlHelpers,
  ClientUrlInterceptRecord,
  ClientUrlItem,
  ClientUrlLoaderRecord,
  ClientUrlPatterns,
  ClientUrlRouteRecord,
  ClientUrlUse,
} from "./types.js";
import type { ExtractRoutes } from "../urls/type-extraction.js";
import type { ClientUrlItems } from "./types.js";

const ITEM_KIND = Symbol("client-url-item");

const TRANSITION_CONFIG_KEYS = new Set<PropertyKey>([
  "enter",
  "exit",
  "update",
  "share",
  "default",
  "name",
  "viewTransition",
]);

const UNSUPPORTED_HELPERS = new Set([
  "include",
  "parallel",
  "cache",
  "error",
  "notFound",
  "errorBoundary",
  "notFoundBoundary",
  "middleware",
]);

type InternalItem =
  | PathItem
  | LayoutItem
  | LoaderItem
  | LoadingItem
  | InterceptItem
  | TransitionItem
  | RevalidateItem;

interface ItemBase {
  readonly [ITEM_KIND]: true;
}

interface PathItem extends ItemBase {
  readonly type: "path";
  readonly pattern: string;
  readonly component: ComponentType;
  readonly options: ClientPathOptions | undefined;
  readonly use: readonly InternalItem[];
}

interface LayoutItem extends ItemBase {
  readonly type: "layout";
  readonly component: ComponentType;
  readonly children: readonly InternalItem[];
}

interface InterceptItem extends ItemBase {
  readonly type: "intercept";
  readonly slotName: `@${string}`;
  /** Bare target name — the leading dot of the dot-local argument is stripped. */
  readonly targetName: string;
  readonly component: ComponentType;
  readonly use: readonly InternalItem[];
}

interface TransitionItem extends ItemBase {
  readonly type: "transition";
  readonly config: ClientTransitionConfig;
}

interface LoaderItem extends ItemBase {
  readonly type: "loader";
  readonly definition: LoaderDefinition<any, any>;
  readonly revalidate: readonly ClientRevalidateFn[];
}

interface RevalidateItem extends ItemBase {
  readonly type: "revalidate";
  readonly fn: ClientRevalidateFn;
}

interface LoadingItem extends ItemBase {
  readonly type: "loading";
  readonly component: ReactNode;
}

interface FlattenContext {
  readonly layouts: readonly ComponentType[];
  readonly loaders: readonly ClientUrlLoaderRecord[];
  readonly loading: ReactNode | undefined;
}

const EMPTY_CONTEXT: FlattenContext = {
  layouts: [],
  loaders: [],
  loading: undefined,
};

function toPublicItem(item: InternalItem): ClientUrlItem {
  return item as unknown as ClientUrlItem;
}

function isInternalItem(value: unknown): value is InternalItem {
  return (
    typeof value === "object" &&
    value !== null &&
    ITEM_KIND in value &&
    (value as ItemBase)[ITEM_KIND] === true
  );
}

function flattenItems(value: unknown, label: string): InternalItem[] {
  if (!Array.isArray(value)) {
    throw new Error(`clientUrls() ${label} callback must return an array`);
  }

  const flattened: InternalItem[] = [];
  const visit = (input: unknown): void => {
    if (Array.isArray(input)) {
      for (const child of input) visit(child);
      return;
    }
    if (!isInternalItem(input)) {
      throw new Error(
        `clientUrls() ${label} callback must return only client URL helper items`,
      );
    }
    flattened.push(input);
  };

  visit(value);
  return flattened;
}

function runUse(use: ClientUrlUse, label: string): InternalItem[] {
  if (typeof use !== "function") {
    throw new Error(`clientUrls() ${label} expects a callback`);
  }
  return flattenItems(use(), label);
}

function rejectItems(
  items: readonly InternalItem[],
  allowed: ReadonlySet<InternalItem["type"]>,
  label: string,
): void {
  for (const item of items) {
    if (!allowed.has(item.type)) {
      throw new Error(
        `clientUrls() does not support ${item.type}() inside ${label}()`,
      );
    }
  }
}

function assertNamedComponent(
  component: unknown,
  helper: "path" | "layout" | "intercept",
): asserts component is ComponentType {
  if (typeof component !== "function" || component.name.trim() === "") {
    throw new Error(
      `clientUrls() ${helper}() expects a named client component value`,
    );
  }
}

function assertLoaderDefinition(
  definition: unknown,
): asserts definition is LoaderDefinition<any, any> {
  const candidate = definition as Partial<LoaderDefinition<any, any>> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    candidate.__brand !== "loader" ||
    typeof candidate.$$id !== "string"
  ) {
    throw new Error(
      "clientUrls() loader() expects a LoaderDefinition created by createLoader()",
    );
  }
}

function createHelpers(): ClientUrlHelpers {
  const path = ((
    pattern: string,
    component: ComponentType,
    optionsOrUse?: ClientPathOptions | ClientUrlUse,
    maybeUse?: ClientUrlUse,
  ): ClientUrlItem => {
    if (typeof pattern !== "string" || !pattern.startsWith("/")) {
      throw new Error(
        'clientUrls() path() pattern must be a string beginning with "/"',
      );
    }
    assertNamedComponent(component, "path");

    let options: ClientPathOptions | undefined;
    let use: ClientUrlUse | undefined;
    if (typeof optionsOrUse === "function") {
      if (maybeUse !== undefined) {
        throw new Error(
          "clientUrls() path() received more than one use callback",
        );
      }
      use = optionsOrUse;
    } else if (optionsOrUse !== undefined) {
      if (typeof optionsOrUse !== "object" || optionsOrUse === null) {
        throw new Error(
          "clientUrls() path() third argument must be PathOptions or a use callback",
        );
      }
      options = { ...optionsOrUse };
      use = maybeUse;
    } else if (maybeUse !== undefined) {
      throw new Error(
        "clientUrls() path() cannot receive a fourth argument without PathOptions",
      );
    }

    if (options?.name !== undefined) {
      if (typeof options.name !== "string" || options.name === "") {
        throw new Error("clientUrls() path() name must be a non-empty string");
      }
      validateUserRouteName(options.name);
    }
    if (
      options?.trailingSlash !== undefined &&
      options.trailingSlash !== "always" &&
      options.trailingSlash !== "never" &&
      options.trailingSlash !== "ignore"
    ) {
      throw new Error(
        'clientUrls() path() trailingSlash must be "always", "never", or "ignore"',
      );
    }

    const items = use ? runUse(use, "path use") : [];
    rejectItems(items, new Set(["loader", "loading", "transition"]), "path");
    if (items.filter((item) => item.type === "transition").length > 1) {
      throw new Error(
        "clientUrls() path() received more than one transition()",
      );
    }
    return toPublicItem({
      [ITEM_KIND]: true,
      type: "path",
      pattern,
      component,
      options,
      use: items,
    });
  }) as ClientUrlHelpers["path"];

  const layout = ((
    component: ComponentType,
    children: ClientUrlUse,
  ): ClientUrlItem => {
    assertNamedComponent(component, "layout");
    const items = runUse(children, "layout children");
    rejectItems(
      items,
      new Set(["path", "layout", "loader", "loading", "intercept"]),
      "layout",
    );
    return toPublicItem({
      [ITEM_KIND]: true,
      type: "layout",
      component,
      children: items,
    });
  }) as ClientUrlHelpers["layout"];

  const loader: ClientUrlHelpers["loader"] = (definition, use) => {
    assertLoaderDefinition(definition);
    const items = use ? runUse(use, "loader use") : [];
    rejectItems(items, new Set(["revalidate"]), "loader");
    return toPublicItem({
      [ITEM_KIND]: true,
      type: "loader",
      definition,
      revalidate: items
        .filter(
          (item): item is Extract<InternalItem, { type: "revalidate" }> =>
            item.type === "revalidate",
        )
        .map((item) => item.fn),
    });
  };

  const revalidate: ClientUrlHelpers["revalidate"] = (fn) => {
    if (typeof fn !== "function") {
      throw new Error("clientUrls() revalidate() expects a predicate function");
    }
    return toPublicItem({
      [ITEM_KIND]: true,
      type: "revalidate",
      fn,
    });
  };

  const loading: ClientUrlHelpers["loading"] = (component) =>
    toPublicItem({ [ITEM_KIND]: true, type: "loading", component });

  const transition: ClientUrlHelpers["transition"] = (config) => {
    if (
      typeof config !== "object" ||
      config === null ||
      Array.isArray(config)
    ) {
      throw new Error(
        "clientUrls() transition() expects a configuration object",
      );
    }
    for (const key of Reflect.ownKeys(config)) {
      if (key === "when") {
        throw new Error(
          "clientUrls() transition() does not support `when` — the gate is a " +
            "server-executed predicate; declare it with a server-tree transition()",
        );
      }
      if (!TRANSITION_CONFIG_KEYS.has(key)) {
        throw new Error(
          `clientUrls() transition() option ${JSON.stringify(String(key))} is not supported`,
        );
      }
    }
    if (config.name !== undefined && typeof config.name !== "string") {
      throw new Error("clientUrls() transition() name must be a string");
    }
    if (
      config.viewTransition !== undefined &&
      config.viewTransition !== "auto" &&
      config.viewTransition !== false
    ) {
      throw new Error(
        'clientUrls() transition() viewTransition must be "auto" or false',
      );
    }
    for (const key of [
      "enter",
      "exit",
      "update",
      "share",
      "default",
    ] as const) {
      const value = config[key];
      if (value === undefined || typeof value === "string") continue;
      const isStringMap =
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((entry) => typeof entry === "string");
      if (!isStringMap) {
        throw new Error(
          `clientUrls() transition() ${key} must be a string or a string map of transition types`,
        );
      }
    }
    return toPublicItem({
      [ITEM_KIND]: true,
      type: "transition",
      config: { ...config },
    });
  };

  const intercept: ClientUrlHelpers["intercept"] = (
    slotName,
    targetName,
    component,
    use,
  ) => {
    if (typeof slotName !== "string" || !/^@.+/.test(slotName)) {
      throw new Error(
        'clientUrls() intercept() slot name must be a string beginning with "@"',
      );
    }
    if (
      typeof targetName !== "string" ||
      !targetName.startsWith(".") ||
      targetName.length < 2
    ) {
      throw new Error(
        'clientUrls() intercept() target must be a dot-local route name like ".detail"',
      );
    }
    assertNamedComponent(component, "intercept");
    const items = use ? runUse(use, "intercept use") : [];
    rejectItems(items, new Set(["loader", "loading"]), "intercept");
    return toPublicItem({
      [ITEM_KIND]: true,
      type: "intercept",
      slotName,
      targetName: targetName.slice(1),
      component,
      use: items,
    });
  };

  const supported: ClientUrlHelpers = {
    path,
    layout,
    loader,
    loading,
    intercept,
    transition,
    revalidate,
  };

  return new Proxy(supported, {
    get(target, property, receiver): unknown {
      if (typeof property === "string" && UNSUPPORTED_HELPERS.has(property)) {
        throw new Error(`clientUrls() does not support ${property}()`);
      }
      if (typeof property === "string" && !(property in target)) {
        throw new Error(`clientUrls() has no ${property}() helper`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function applyConfig(
  context: FlattenContext,
  items: readonly InternalItem[],
): FlattenContext {
  const loaders = [...context.loaders];
  let loading = context.loading;

  for (const item of items) {
    if (item.type === "loader") {
      loaders.push(
        Object.freeze({
          loader: item.definition,
          revalidate: Object.freeze([...item.revalidate]),
        }),
      );
    } else if (item.type === "loading") {
      loading = item.component;
    }
  }

  return {
    layouts: context.layouts,
    loaders,
    loading,
  };
}

function addPathRecord(
  item: PathItem,
  context: FlattenContext,
  routes: ClientUrlRouteRecord[],
): void {
  const routeContext = applyConfig(context, item.use);
  const options = item.options ? Object.freeze({ ...item.options }) : undefined;
  // Route-scoped only: transition() is rejected outside path() use callbacks,
  // so there is no layout-level inheritance to fold in.
  const transitionItem = item.use.find(
    (useItem): useItem is Extract<InternalItem, { type: "transition" }> =>
      useItem.type === "transition",
  );
  routes.push(
    Object.freeze({
      id: `client-route-${routes.length}`,
      pattern: item.pattern,
      name: options?.name,
      options,
      component: item.component,
      layouts: Object.freeze([...routeContext.layouts]),
      loaders: Object.freeze([...routeContext.loaders]),
      loading: routeContext.loading,
      transition: transitionItem
        ? Object.freeze({ ...transitionItem.config })
        : undefined,
    }),
  );
}

function flattenLayout(
  item: LayoutItem,
  context: FlattenContext,
  routes: ClientUrlRouteRecord[],
): void {
  const routeCount = routes.length;
  const layoutContext = applyConfig(
    {
      ...context,
      layouts: [...context.layouts, item.component],
    },
    item.children,
  );

  flattenRoutes(item.children, layoutContext, routes);
  if (routes.length === routeCount) {
    throw new Error(
      "clientUrls() layout() children must contain at least one path()",
    );
  }
}

function flattenRoutes(
  items: readonly InternalItem[],
  context: FlattenContext,
  routes: ClientUrlRouteRecord[],
): void {
  for (const item of items) {
    if (item.type === "path") {
      addPathRecord(item, context, routes);
    } else if (item.type === "layout") {
      flattenLayout(item, context, routes);
    }
  }
}

function validateRoutes(routes: readonly ClientUrlRouteRecord[]): void {
  const patterns = new Set<string>();
  const names = new Set<string>();
  for (const route of routes) {
    if (patterns.has(route.pattern)) {
      throw new Error(
        `clientUrls() cannot define duplicate path pattern "${route.pattern}"`,
      );
    }
    patterns.add(route.pattern);

    if (route.name !== undefined) {
      if (names.has(route.name)) {
        throw new Error(
          `clientUrls() cannot define duplicate route name "${route.name}"`,
        );
      }
      names.add(route.name);
    }
  }
}

function collectIntercepts(
  items: readonly InternalItem[],
  intercepts: ClientUrlInterceptRecord[],
): void {
  for (const item of items) {
    if (item.type === "intercept") {
      const loaders: ClientUrlLoaderRecord[] = [];
      let loading: ReactNode | undefined;
      for (const useItem of item.use) {
        if (useItem.type === "loader") {
          loaders.push(
            Object.freeze({
              loader: useItem.definition,
              revalidate: Object.freeze([...useItem.revalidate]),
            }),
          );
        } else if (useItem.type === "loading") {
          loading = useItem.component;
        }
      }
      intercepts.push(
        Object.freeze({
          slotName: item.slotName,
          targetName: item.targetName,
          component: item.component,
          loaders: Object.freeze(loaders),
          loading,
        }),
      );
    } else if (item.type === "layout") {
      collectIntercepts(item.children, intercepts);
    }
  }
}

function validateIntercepts(
  intercepts: readonly ClientUrlInterceptRecord[],
  routes: readonly ClientUrlRouteRecord[],
): void {
  const names = new Set<string>();
  for (const route of routes) {
    if (route.name !== undefined) names.add(route.name);
  }
  for (const intercept of intercepts) {
    if (!names.has(intercept.targetName)) {
      throw new Error(
        `clientUrls() intercept() target ".${intercept.targetName}" does not match a named path() in this definition`,
      );
    }
  }
}

export function clientUrls<const TItems extends ClientUrlItems>(
  builder: ClientUrlBuilder<TItems>,
): ClientUrlPatterns<ExtractRoutes<TItems>> {
  if (typeof builder !== "function") {
    throw new Error("clientUrls() expects a builder function");
  }

  const items = flattenItems(builder(createHelpers()), "builder");
  rejectItems(items, new Set(["path", "layout", "intercept"]), "clientUrls");

  const routes: ClientUrlRouteRecord[] = [];
  const rootContext = applyConfig(EMPTY_CONTEXT, items);
  flattenRoutes(items, rootContext, routes);
  if (routes.length === 0) {
    throw new Error("clientUrls() builder must define at least one path()");
  }
  validateRoutes(routes);

  const intercepts: ClientUrlInterceptRecord[] = [];
  collectIntercepts(items, intercepts);
  validateIntercepts(intercepts, routes);

  const routeManifest: Record<string, string> = {};
  const staticPrefixes: Record<string, string> = {};
  const trailingSlash: Record<string, string> = {};
  for (const route of routes) {
    routeManifest[route.id] = route.pattern;
    staticPrefixes[route.id] = "";
    if (route.options?.trailingSlash) {
      trailingSlash[route.id] = route.options.trailingSlash;
    }
  }
  const trie = buildRouteTrie(routeManifest, staticPrefixes, trailingSlash);

  return Object.freeze({
    __brand: "client-urls" as const,
    routes: Object.freeze(routes),
    intercepts: Object.freeze(intercepts),
    match(pathname: string) {
      return tryTrieMatch(trie, pathname);
    },
  }) as ClientUrlPatterns<ExtractRoutes<TItems>>;
}

export type {
  ClientRevalidateArgs,
  ClientRevalidateFn,
  ClientTransitionConfig,
  ClientUrlBuilder,
  ClientUrlHelpers,
  ClientUrlInterceptRecord,
  ClientUrlItem,
  ClientUrlItemInput,
  ClientUrlItems,
  ClientLayoutFn,
  ClientPathOptions,
  ClientUrlLoaderRecord,
  ClientPathFn,
  ClientUrlPatterns,
  ClientUrlRouteRecord,
  ClientUrlUse,
} from "./types.js";
