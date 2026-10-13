import * as React from "react";
import type { SearchSchemaValue } from "../search-params.js";
import { getLoaderLazy } from "../server/loader-registry.js";
import {
  getContext,
  getNamePrefix,
  getUrlPrefix,
  peekShortCode,
  type InterceptSelectorContext,
} from "../server/context.js";
import type {
  LoaderDefinition,
  ShouldRevalidateFn,
  TrailingSlashMode,
} from "../types.js";
import type {
  PartialPrerenderProps,
  PathOptions,
  UrlPatterns,
} from "../urls/pattern-types.js";
import type { PathHelpers } from "../urls/path-helper-types.js";
import type { AllUseItems } from "../route-types.js";
import { urls } from "../urls/urls-function.js";
import { isHoistedRevalidateRef } from "./hoisted-revalidate.js";
import { getClientUrlRevalidator } from "./revalidate-registry.js";
import { setLayoutLoaderCopies } from "./layout-loader-copies.js";
import {
  ClientUrlsGroupLayout,
  ClientUrlsInterceptLoading,
  ClientUrlsInterceptSlot,
  ClientUrlsLoading,
  ClientUrlsRoot,
} from "./client-root.js";
import { createClientUrlsWhenRef } from "../transition-when-ref.js";
import type {
  ClientTransitionConfig,
  ClientUrlInterceptRecord,
  ClientUrlLoaderRecord,
  ClientUrlPatterns,
  ClientUrlRouteRecord,
} from "./types.js";

const CLIENT_REFERENCE = Symbol.for("react.client.reference");

const SEARCH_SCHEMA_VALUES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "string?",
  "number?",
  "boolean?",
]);

const PROJECTION_OPTIONS = new Set<PropertyKey>([
  "name",
  "search",
  "trailingSlash",
  "ppr",
]);

const PPR_NUMBER_KEYS = new Set<PropertyKey>([
  "ttl",
  "swr",
  "captureTimeout",
  "maxSnapshotBytes",
]);

const clientUrlProjections = new Map<string, ClientUrlProjection>();

export interface ClientUrlReference {
  readonly $$typeof: symbol;
  readonly $$id: string;
}

export type ClientUrlDefinitionSource = ClientUrlReference | ClientUrlPatterns;

export interface ClientUrlProjectionOptions {
  readonly search?: Readonly<Record<string, SearchSchemaValue>>;
  readonly trailingSlash?: TrailingSlashMode;
  /**
   * The `ppr` path option, JSON-projected. Materialization passes it onto
   * the group route's server `path()` verbatim, so the manifest entry
   * carries it and the runtime shell capture/serve lanes engage exactly as
   * for a hand-written server route (search is part of shell identity —
   * the capture render seeds the key's own search, so group static parts
   * may read useSearchParams).
   */
  readonly ppr?: true | Readonly<PartialPrerenderProps>;
}

export interface ClientUrlProjectionRoute {
  readonly id: string;
  readonly pattern: string;
  readonly name: string | null;
  readonly options: ClientUrlProjectionOptions;
  readonly loaderIds: readonly string[];
  readonly hasLoading: boolean;
  /** Indices into loaderIds of loaders declared loader(Def, { ssr: false });
   *  materialization passes the option through to the server loader() so
   *  document renders await them before first flush. Absent (= none) in
   *  projections serialized before the option existed. */
  readonly awaitedLoaderIndices?: readonly number[];
  /** Indices into loaderIds of loaders declared loader(Def, { prefetch:
   *  false }); materialization passes the option through to the server
   *  loader(), so a prefetch of the route defers them. Absent (= none) in
   *  projections serialized before the option existed. */
  readonly deferrableLoaderIndices?: readonly number[];
  /** Per loader (aligned with loaderIds), the keys of its hoisted
   *  revalidate() predicates in declaration order; materialization attaches
   *  the registered predicates (revalidate-registry.ts). Absent when no
   *  loader declares one. */
  readonly loaderRevalidate?: readonly (readonly string[])[];
  /** One per leading loader its layout()s declare
   *  (ClientUrlRouteRecord.layoutLoaders): the record's ordinal in the
   *  definition. Two routes whose loader at an index carries the same ordinal
   *  hold one layout() loader (layout-loader-copies.ts). Absent when none. */
  readonly layoutLoaders?: readonly number[];
  /** Data-only transition config (never `when`); absent in projections
   *  serialized before transition support. */
  readonly transition?: Readonly<ClientTransitionConfig>;
  /** The route's transition() declares a browser-run `when`. Materialization
   *  attaches a clientUrls when reference (definition + route id). */
  readonly transitionWhen?: true;
}

export interface ClientUrlProjectionIntercept {
  readonly slotName: `@${string}`;
  /** Bare local target name; materialization re-dots it so the server
   *  intercept() helper composes it against the include's name prefix. */
  readonly targetName: string;
  readonly loaderIds: readonly string[];
  readonly hasLoading: boolean;
}

export interface ClientUrlProjection {
  readonly version: 1;
  readonly routes: readonly ClientUrlProjectionRoute[];
  /** Absent in projections serialized before intercept support; consumers
   *  must treat missing as empty. */
  readonly intercepts?: readonly ClientUrlProjectionIntercept[];
}

function routeDescription(route: ClientUrlRouteRecord): string {
  return `route "${route.pattern}" (${route.id})`;
}

function projectionError(route: ClientUrlRouteRecord, message: string): Error {
  return new Error(
    `clientUrls() cannot create a server projection for ${routeDescription(route)}: ${message}`,
  );
}

function serializeSearchSchema(
  route: ClientUrlRouteRecord,
  value: unknown,
): Readonly<Record<string, SearchSchemaValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw projectionError(route, 'path option "search" must be an object');
  }

  const entries: Array<[string, SearchSchemaValue]> = [];
  for (const key of Object.keys(value).sort()) {
    const schemaValue = (value as Record<string, unknown>)[key];
    if (
      typeof schemaValue !== "string" ||
      !SEARCH_SCHEMA_VALUES.has(schemaValue)
    ) {
      throw projectionError(
        route,
        `path option "search.${key}" has unsupported value ${JSON.stringify(schemaValue)}`,
      );
    }
    entries.push([key, schemaValue as SearchSchemaValue]);
  }

  return Object.freeze(Object.fromEntries(entries));
}

function serializeOptions(
  route: ClientUrlRouteRecord,
): ClientUrlProjectionOptions {
  const source = route.options;
  if (!source) return Object.freeze({});

  for (const key of Reflect.ownKeys(source)) {
    if (!PROJECTION_OPTIONS.has(key)) {
      throw projectionError(
        route,
        `path option ${JSON.stringify(String(key))} is not supported`,
      );
    }
  }

  const options: {
    search?: Readonly<Record<string, SearchSchemaValue>>;
    trailingSlash?: TrailingSlashMode;
    ppr?: true | Readonly<PartialPrerenderProps>;
  } = {};
  if (source.search !== undefined) {
    options.search = serializeSearchSchema(route, source.search);
  }
  if (source.trailingSlash !== undefined) {
    options.trailingSlash = source.trailingSlash;
  }
  if (source.ppr !== undefined) {
    options.ppr = serializePpr(route, source.ppr);
  }
  return Object.freeze(options);
}

/**
 * Serialize the `ppr` path option for the projection. The DSL already
 * validated shape in the authoring module (validateClientPpr in
 * client-urls.ts); this re-validates independently and re-copies
 * defensively — the projection must carry only JSON, and the copy keeps a
 * later mutation of the consumer's options object from leaking into the
 * frozen projection.
 */
function serializePpr(
  route: ClientUrlRouteRecord,
  source: unknown,
): true | Readonly<PartialPrerenderProps> {
  if (source === true) return true;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw projectionError(
      route,
      'path option "ppr" must be true or a PartialPrerenderProps object',
    );
  }
  const out: {
    ttl?: number;
    swr?: number;
    captureTimeout?: number;
    maxSnapshotBytes?: number;
    tags?: readonly string[];
  } = {};
  for (const key of Reflect.ownKeys(source)) {
    if (PPR_NUMBER_KEYS.has(key)) {
      const value = (source as Record<PropertyKey, unknown>)[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw projectionError(
          route,
          `path option "ppr.${String(key)}" must be a finite number`,
        );
      }
      out[key as "ttl" | "swr" | "captureTimeout" | "maxSnapshotBytes"] = value;
      continue;
    }
    if (key === "tags") {
      const tags = (source as { tags: unknown }).tags;
      if (
        !Array.isArray(tags) ||
        tags.some((tag) => typeof tag !== "string" || tag === "")
      ) {
        throw projectionError(
          route,
          'path option "ppr.tags" must be an array of non-empty strings',
        );
      }
      out.tags = Object.freeze([...tags]);
      continue;
    }
    throw projectionError(
      route,
      `path option "ppr.${String(key)}" is not supported`,
    );
  }
  return Object.freeze(out) as Readonly<PartialPrerenderProps>;
}

function serializeTransition(
  route: ClientUrlRouteRecord,
): Readonly<ClientTransitionConfig> | undefined {
  const source = route.transition;
  if (!source) return undefined;
  // The DSL already validated shape; re-copy defensively so the projection is
  // a plain JSON value (class maps included). `when` is a function: the
  // projection records only that it exists (transitionWhen).
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key === "when") continue;
    config[key] =
      typeof value === "object" && value !== null
        ? Object.freeze({ ...(value as Record<string, string>) })
        : value;
  }
  return Object.freeze(config) as Readonly<ClientTransitionConfig>;
}

/** Options for {@link serializeClientUrlPatterns}. */
export interface SerializeClientUrlPatternsOptions {
  /**
   * The definition was loaded through the rango Vite plugin (route
   * discovery), which moves every revalidate() predicate to the server and
   * leaves a marker: a plain function then is a site the build could not
   * see, and fails loudly.
   */
  readonly hoisted?: boolean;
}

function indicesWhere<T>(
  items: readonly T[],
  pred: (item: T) => boolean,
): number[] {
  return items.flatMap((item, index) => (pred(item) ? [index] : []));
}

function serializeRoute(
  route: ClientUrlRouteRecord,
  options: SerializeClientUrlPatternsOptions,
  ordinals: Map<ClientUrlLoaderRecord, number>,
): ClientUrlProjectionRoute {
  // flattenLayout creates a layout()'s records once for every route below it.
  const layoutLoaders = route.layoutLoaders.map((record) => {
    if (!ordinals.has(record)) ordinals.set(record, ordinals.size);
    return ordinals.get(record)!;
  });
  const loaderIds = route.loaders.map(({ loader }, index) => {
    if (typeof loader.$$id !== "string" || loader.$$id.length === 0) {
      throw projectionError(
        route,
        `loader at index ${index} is missing a non-empty $$id`,
      );
    }
    return loader.$$id;
  });

  const loaderRevalidate = route.loaders.map(({ loader, revalidate }) =>
    revalidate.flatMap((entry) => {
      if (isHoistedRevalidateRef(entry)) return [entry.$$rangoRevalidate];
      if (options.hoisted) {
        throw new Error(
          `clientUrls() revalidate() on loader "${loader.$$id}" of route ` +
            `"${route.pattern}" was not hoisted to the server: call the ` +
            "builder's revalidate() helper with an inline function or an " +
            "imported predicate.",
        );
      }
      return [];
    }),
  );

  const awaitedLoaderIndices = indicesWhere(
    route.loaders,
    ({ ssr }) => ssr === false,
  );
  const deferrableLoaderIndices = indicesWhere(
    route.loaders,
    ({ prefetch }) => prefetch === false,
  );

  const transition = serializeTransition(route);
  return Object.freeze({
    id: route.id,
    pattern: route.pattern,
    name: route.name ?? null,
    options: serializeOptions(route),
    loaderIds: Object.freeze(loaderIds),
    hasLoading: route.loading !== undefined,
    ...(awaitedLoaderIndices.length > 0
      ? { awaitedLoaderIndices: Object.freeze(awaitedLoaderIndices) }
      : {}),
    ...(deferrableLoaderIndices.length > 0
      ? { deferrableLoaderIndices: Object.freeze(deferrableLoaderIndices) }
      : {}),
    ...(loaderRevalidate.some((keys) => keys.length > 0)
      ? {
          loaderRevalidate: Object.freeze(
            loaderRevalidate.map((keys) => Object.freeze(keys)),
          ),
        }
      : {}),
    ...(layoutLoaders.length > 0
      ? { layoutLoaders: Object.freeze(layoutLoaders) }
      : {}),
    ...(transition ? { transition } : {}),
    ...(typeof route.transition?.when === "function"
      ? { transitionWhen: true as const }
      : {}),
  });
}

function serializeIntercept(
  record: ClientUrlInterceptRecord,
  index: number,
): ClientUrlProjectionIntercept {
  const loaderIds = record.loaders.map(({ loader }, loaderIndex) => {
    if (typeof loader.$$id !== "string" || loader.$$id.length === 0) {
      throw new Error(
        `clientUrls() cannot create a server projection for intercept ".${record.targetName}" ` +
          `(index ${index}): loader at index ${loaderIndex} is missing a non-empty $$id`,
      );
    }
    return loader.$$id;
  });

  return Object.freeze({
    slotName: record.slotName,
    targetName: record.targetName,
    loaderIds: Object.freeze(loaderIds),
    hasLoading: record.loading !== undefined,
  });
}

export function serializeClientUrlPatterns(
  patterns: ClientUrlPatterns,
  options: SerializeClientUrlPatternsOptions = {},
): ClientUrlProjection {
  const ordinals = new Map<ClientUrlLoaderRecord, number>();
  return Object.freeze({
    version: 1 as const,
    routes: Object.freeze(
      patterns.routes.map((route) => serializeRoute(route, options, ordinals)),
    ),
    intercepts: Object.freeze(
      (patterns.intercepts ?? []).map(serializeIntercept),
    ),
  });
}

/**
 * The projection of a clientUrls() module from its namespace, or undefined
 * when its default export is not a clientUrls() definition. Discovery
 * (vite/discovery/client-urls-projection.ts) and the testing "use client"
 * transform (testing/internal/client-urls-projection.ts) both project a
 * module through it.
 */
export function projectClientUrlsModule(
  namespace: Readonly<Record<string, unknown>>,
  options: SerializeClientUrlPatternsOptions = {},
): ClientUrlProjection | undefined {
  const definition = namespace.default;
  if (
    (typeof definition !== "object" && typeof definition !== "function") ||
    definition === null ||
    (definition as { __brand?: unknown }).__brand !== "client-urls"
  ) {
    return undefined;
  }
  return serializeClientUrlPatterns(definition as ClientUrlPatterns, options);
}

export function isClientUrlPatterns(
  value: unknown,
): value is ClientUrlPatterns {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === "client-urls" &&
    Array.isArray((value as { routes?: unknown }).routes)
  );
}

export function isClientUrlReference(
  value: unknown,
): value is ClientUrlReference {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return false;
  }

  try {
    const reference = value as Partial<ClientUrlReference>;
    return (
      reference.$$typeof === CLIENT_REFERENCE &&
      typeof reference.$$id === "string" &&
      reference.$$id.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * A clientUrls() definition object or, on the server, its client reference.
 * Run this BEFORE any duck-typing of the value (`typeof === "function"`,
 * `.handler` reads): a client reference is a callable Proxy that throws on
 * unknown property reads, so a later shape check would either invoke it as a
 * thunk or surface React's "cannot dot into a client module" error.
 */
export function isClientUrlSource(
  value: unknown,
): value is ClientUrlDefinitionSource {
  return isClientUrlPatterns(value) || isClientUrlReference(value);
}

/**
 * Strip vite's HMR timestamp query from a module id. After an HMR update of
 * a clientUrls module, the RSC graph re-imports it under
 * `<path>?t=<timestamp>#default`, so the include's client reference carries a
 * t-stamped $$id while the projection was registered under the bare id — the
 * lookup missed and every request 500'd until a server restart. Only the
 * `t` param is removed (other queries are part of module identity).
 */
function stripHmrTimestamp(id: string): string {
  return id.replace(/([?&])t=\d+(&)?/, (_match, lead: string, trail?: string) =>
    trail ? lead : "",
  );
}

function projectionKey(reference: string | ClientUrlReference): string {
  if (typeof reference === "string" && reference.length > 0) {
    return stripHmrTimestamp(reference);
  }
  if (isClientUrlReference(reference)) {
    return stripHmrTimestamp(reference.$$id);
  }
  throw new Error(
    "Client URL projections require a React client reference with a non-empty $$id",
  );
}

export function setClientUrlProjection(
  reference: string | ClientUrlReference,
  projection: ClientUrlProjection,
): void {
  clientUrlProjections.set(projectionKey(reference), projection);
}

export function getClientUrlProjection(
  reference: string | ClientUrlReference,
): ClientUrlProjection | undefined {
  return clientUrlProjections.get(projectionKey(reference));
}

export function clearClientUrlProjections(): void {
  clientUrlProjections.clear();
}

/**
 * The revalidate() predicates of one materialized loader. A definition
 * object (unit tests, the testing primitives) carries its functions. A
 * client reference resolves the projection's content keys in the registry
 * the group's hoisted module filled when it loaded; a key with no
 * registration fails loudly here, at materialization, never at a request.
 */
function loaderRevalidators(
  reference: ClientUrlDefinitionSource,
  route: ClientUrlProjectionRoute,
  loaderIndex: number,
): ShouldRevalidateFn<any, any>[] {
  const fromRegistry = (key: string): ShouldRevalidateFn<any, any> => {
    if (!getClientUrlRevalidator(key)) {
      const id = isClientUrlReference(reference) ? reference.$$id : "(inline)";
      throw new Error(
        `clientUrls() revalidate() on loader "${route.loaderIds[loaderIndex]}" ` +
          `of route "${route.pattern}" in "${id}" has no server ` +
          `registration (key "${key}"). The rango Vite plugin registers ` +
          "hoisted predicates when the group's module loads in the RSC " +
          "environment; a transform that changed the predicate's syntax " +
          "in one environment only also causes this.",
      );
    }
    // Looked up per call: a dev re-evaluation of the hoisted module
    // re-registers the key with functions bound to the current imports.
    return (args) => getClientUrlRevalidator(key)!(args);
  };
  if (isClientUrlPatterns(reference)) {
    const record = reference.routes.find(({ id }) => id === route.id);
    return (record?.loaders[loaderIndex]?.revalidate ?? []).map((entry) =>
      isHoistedRevalidateRef(entry)
        ? fromRegistry(entry.$$rangoRevalidate)
        : entry,
    );
  }
  return (route.loaderRevalidate?.[loaderIndex] ?? []).map(fromRegistry);
}

function createLoaderStub(id: string): LoaderDefinition<unknown> {
  return {
    __brand: "loader",
    $$id: id,
    fn: async (ctx) => {
      const registeredLoader = await getLoaderLazy(id);
      if (!registeredLoader) {
        throw new Error(
          `Projected loader "${id}" was not found in the server loader registry`,
        );
      }
      return registeredLoader.fn(ctx);
    },
  };
}

function materializedPathOptions(
  route: ClientUrlProjectionRoute,
  clientGroup: string,
): PathOptions {
  return {
    clientGroup,
    ...(route.name === null ? {} : { name: route.name }),
    ...(route.options.search ? { search: { ...route.options.search } } : {}),
    ...(route.options.trailingSlash
      ? { trailingSlash: route.options.trailingSlash }
      : {}),
    // ppr rides onto the materialized server path() verbatim: path-helper
    // stamps it on the manifest entry, so resolvePprConfig classifies the
    // group route exactly like a hand-written ppr page. Shallow-copy the
    // object form — path-helper receives a mutable PathOptions.
    ...(route.options.ppr !== undefined
      ? {
          ppr: route.options.ppr === true ? true : { ...route.options.ppr },
        }
      : {}),
  };
}

function materializeRouteItems(
  reference: ClientUrlDefinitionSource,
  projection: ClientUrlProjection,
  {
    path,
    layout,
    loader,
    loading,
    intercept,
    transition,
    revalidate,
  }: PathHelpers<any>,
): AllUseItems[] {
  // The urls() builder runs under the include's prefixes, so the composed
  // route-name prefix is available here. ClientUrlsRoot needs it to compose
  // canonical names for intercept-target coordination in the browser.
  const namePrefix = getNamePrefix();
  // One key per group MOUNT (the include's URL prefix): renderSegments keys
  // every route segment of the group by it (ResolvedSegment.clientGroup).
  const clientGroup = getUrlPrefix() || "/";

  // Helper calls attach to the CURRENT ctx.parent as they execute, so these
  // builders must run where the items belong: at the module top level for the
  // flat (no-intercept) shape, or inside the group layout's children callback
  // when intercepts wrap the group.
  const buildRouteItems = (): AllUseItems[] => {
    // Each route's shortCode, read before path() takes them: one per route,
    // in order, from the same counter. An evaluation for one route skips the
    // others' entries, not their codes.
    const codes = projection.routes.map((_, ahead) =>
      peekShortCode("route", ahead),
    );
    // A route's use(), recording each layout() loader copy's ids under the
    // other routes of its layout() (layout-loader-copies.ts). path() runs it
    // with the route entry as parent, whose loaders it has created on return.
    const recordingCopies =
      <T>(routeIndex: number, use: () => T) =>
      (): T => {
        const items = use();
        const entry = getContext().getParent()!;
        projection.routes[routeIndex].layoutLoaders?.forEach(
          (ordinal, loaderIndex) =>
            setLayoutLoaderCopies(
              entry.loader[loaderIndex].loader,
              projection.routes.flatMap((other, otherIndex) =>
                otherIndex !== routeIndex &&
                other.layoutLoaders?.[loaderIndex] === ordinal
                  ? [
                      `${codes[otherIndex]}D${loaderIndex}.${other.loaderIds[loaderIndex]}`,
                    ]
                  : [],
              ),
            ),
        );
        return items;
      };
    return projection.routes.map(
      (route, routeIndex) =>
        path(
          route.pattern,
          () =>
            React.createElement(ClientUrlsRoot, {
              definition: reference as ClientUrlPatterns,
              routeId: route.id,
              namePrefix,
            }),
          materializedPathOptions(route, clientGroup),
          recordingCopies(routeIndex, () => [
            ...route.loaderIds.map((id, loaderIndex) => {
              const revalidators = loaderRevalidators(
                reference,
                route,
                loaderIndex,
              );
              return loader(
                createLoaderStub(id),
                {
                  ...(route.awaitedLoaderIndices?.includes(loaderIndex) && {
                    ssr: false,
                  }),
                  ...(route.deferrableLoaderIndices?.includes(loaderIndex) && {
                    prefetch: false,
                  }),
                },
                () => revalidators.map((fn) => revalidate(fn)),
              );
            }),
            ...(route.hasLoading
              ? [
                  loading(
                    React.createElement(ClientUrlsLoading, {
                      definition: reference as ClientUrlPatterns,
                      routeId: route.id,
                    }),
                  ),
                ]
              : []),
            // Per-route transition config: same child position as a
            // hand-written server transition(config). A declared `when` rides
            // as a reference to the definition + route id; the browser calls
            // the function the "use client" module declares.
            ...(route.transition
              ? [
                  transition({
                    ...route.transition,
                    ...(route.transitionWhen
                      ? { when: createClientUrlsWhenRef(reference, route.id) }
                      : {}),
                  }),
                ]
              : []),
          ]),
        ) as AllUseItems,
    );
  };

  const intercepts = projection.intercepts ?? [];
  if (intercepts.length === 0) return buildRouteItems();

  // Two server-side mechanics make client-declared intercepts work:
  //
  // 1. GROUP LAYOUT ATTACHMENT. findInterceptForRoute walks the TARGET
  //    route's parent chain, so the intercept must live on an entry in that
  //    chain that survives evaluation. Emitting intercepts at the module top
  //    level attaches them to the lazy expansion's ISOLATED parent clone
  //    (getIsolatedLazyParent in server/context.ts), which is discarded.
  //    Wrapping the group in one materialized layout gives them a persistent
  //    home in the target chain — and the layout renders each declared slot,
  //    so the modal presents inside the group's own subtree (the slot segment
  //    attaches to the declaring entry; an outer layout's same-named outlet
  //    would never receive it).
  //
  // 2. SYNTHESIZED ORIGIN `when`. The target-chain walk is origin-blind: a
  //    bare intercept would claim navigations from ANY origin — and for an
  //    out-of-group origin the slot's host layout is not in the rendered
  //    tree, so the modal would silently vanish. The declaration contract is
  //    module-local, so materialization synthesizes the origin check the DSL
  //    deliberately does not expose: activate only when the origin pathname
  //    is inside this include's mount. This is server-generated code — no
  //    function crosses the "use client" projection boundary.
  const mount = getUrlPrefix() || "/";
  const isInGroupOrigin = ({ from }: InterceptSelectorContext): boolean =>
    mount === "/"
      ? true
      : from.url.pathname === mount ||
        from.url.pathname.startsWith(`${mount}/`);
  const slotNames = [...new Set(intercepts.map((record) => record.slotName))];
  const buildInterceptItems = (): AllUseItems[] =>
    intercepts.map(
      (record, interceptIndex) =>
        intercept(
          record.slotName,
          `.${record.targetName}`,
          () =>
            React.createElement(ClientUrlsInterceptSlot, {
              definition: reference as ClientUrlPatterns,
              interceptIndex,
            }),
          { when: isInGroupOrigin },
          () => [
            ...record.loaderIds.map((id) => loader(createLoaderStub(id))),
            ...(record.hasLoading
              ? [
                  loading(
                    React.createElement(ClientUrlsInterceptLoading, {
                      definition: reference as ClientUrlPatterns,
                      interceptIndex,
                    }),
                  ),
                ]
              : []),
          ],
        ) as AllUseItems,
    );

  function ClientUrlsGroup(): React.ReactNode {
    return React.createElement(ClientUrlsGroupLayout, { slotNames });
  }

  return [
    layout(ClientUrlsGroup, () => [
      ...buildRouteItems(),
      ...buildInterceptItems(),
    ]) as AllUseItems,
  ];
}

function assertClientUrlSource(
  value: unknown,
  caller: string,
): asserts value is ClientUrlDefinitionSource {
  if (!isClientUrlReference(value) && !isClientUrlPatterns(value)) {
    throw new Error(
      `${caller} expects clientUrls() patterns or a React client reference with a non-empty $$id`,
    );
  }
}

export function materializeClientUrlPatterns(
  reference: ClientUrlDefinitionSource,
  projection: ClientUrlProjection,
): UrlPatterns {
  assertClientUrlSource(reference, "materializeClientUrlPatterns()");
  return urls((helpers) =>
    materializeRouteItems(reference, projection, helpers),
  );
}

/**
 * Adapt a clientUrls() source for `include()` mounting inside the canonical
 * urls() tree. Materialization is DEFERRED into the returned handler: it
 * resolves the discovery-installed projection at evaluation time (lazy include
 * expansion, build manifest generation, dev per-request trie rebuild) — by
 * then the routes-manifest bootstrap has installed projections, so registration
 * order never matters. The include machinery applies the URL and route-name
 * prefixes exactly as it does for any urls() module; surrounding RSC layouts,
 * middleware scoping, and boundaries derive from the canonical server tree.
 */
export function clientUrlIncludePatterns(
  source: ClientUrlDefinitionSource,
): UrlPatterns {
  assertClientUrlSource(source, "include() with a clientUrls() definition");
  return urls((helpers) => {
    const projection = isClientUrlPatterns(source)
      ? serializeClientUrlPatterns(source)
      : getClientUrlProjection(source);
    if (!projection) {
      const id = isClientUrlReference(source) ? source.$$id : "(inline)";
      throw new Error(
        `include() could not resolve the server projection for clientUrls() module "${id}". ` +
          'The definition must be the default export of a "use client" module so the ' +
          "Vite discovery pass can project it; in a Vitest project, rangoUseClientTransform() " +
          "from @rangojs/router/testing/vitest projects it.",
      );
    }
    return materializeRouteItems(source, projection, helpers);
  });
}
