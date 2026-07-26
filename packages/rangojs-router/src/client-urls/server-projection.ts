import * as React from "react";
import type { SearchSchemaValue } from "../search-params.js";
import { getLoaderLazy } from "../server/loader-registry.js";
import {
  getNamePrefix,
  getUrlPrefix,
  type InterceptSelectorContext,
} from "../server/context.js";
import type { LoaderDefinition, TrailingSlashMode } from "../types.js";
import type { PathOptions, UrlPatterns } from "../urls/pattern-types.js";
import type { PathHelpers } from "../urls/path-helper-types.js";
import type { AllUseItems } from "../route-types.js";
import { urls } from "../urls/urls-function.js";
import {
  CLIENT_REVALIDATION_HEADER,
  decodeClientRevalidationDecisions,
  type ClientRevalidationDecisions,
} from "./revalidation-protocol.js";
import {
  ClientUrlsGroupLayout,
  ClientUrlsInterceptLoading,
  ClientUrlsInterceptSlot,
  ClientUrlsLoading,
  ClientUrlsRoot,
} from "./client-root.js";
import type {
  ClientTransitionConfig,
  ClientUrlInterceptRecord,
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
}

export interface ClientUrlProjectionRoute {
  readonly id: string;
  readonly pattern: string;
  readonly name: string | null;
  readonly options: ClientUrlProjectionOptions;
  readonly loaderIds: readonly string[];
  readonly hasLoading: boolean;
  /** Indices into loaderIds of loaders declared loader(Def, { stream:
   *  "navigation" }); materialization passes the option through to the server
   *  loader() so document renders await them before first flush. Absent (=
   *  none) in projections serialized before stream support. */
  readonly awaitedLoaderIndices?: readonly number[];
  /** Data-only transition config (no `when` — server-tree only); absent in
   *  projections serialized before transition support. */
  readonly transition?: Readonly<ClientTransitionConfig>;
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
    if (key === "ppr") {
      throw projectionError(route, 'path option "ppr" is not supported');
    }
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
  } = {};
  if (source.search !== undefined) {
    options.search = serializeSearchSchema(route, source.search);
  }
  if (source.trailingSlash !== undefined) {
    options.trailingSlash = source.trailingSlash;
  }
  return Object.freeze(options);
}

function serializeTransition(
  route: ClientUrlRouteRecord,
): Readonly<ClientTransitionConfig> | undefined {
  const source = route.transition;
  if (!source) return undefined;
  // The DSL already validated shape and rejected `when`; re-copy defensively
  // so the projection is a plain JSON value (class maps included).
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    config[key] =
      typeof value === "object" && value !== null
        ? Object.freeze({ ...(value as Record<string, string>) })
        : value;
  }
  return Object.freeze(config) as Readonly<ClientTransitionConfig>;
}

function serializeRoute(route: ClientUrlRouteRecord): ClientUrlProjectionRoute {
  const loaderIds = route.loaders.map(({ loader }, index) => {
    if (typeof loader.$$id !== "string" || loader.$$id.length === 0) {
      throw projectionError(
        route,
        `loader at index ${index} is missing a non-empty $$id`,
      );
    }
    return loader.$$id;
  });

  const awaitedLoaderIndices = route.loaders
    .map(({ stream }, index) => (stream === "navigation" ? index : -1))
    .filter((index) => index >= 0);

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
    ...(transition ? { transition } : {}),
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
): ClientUrlProjection {
  return Object.freeze({
    version: 1 as const,
    routes: Object.freeze(patterns.routes.map(serializeRoute)),
    intercepts: Object.freeze(
      (patterns.intercepts ?? []).map(serializeIntercept),
    ),
  });
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
 * Per-request memo for decoded client revalidation decisions: the synthesized
 * predicate below runs once per loader stub per revalidation pass, and every
 * stub reads the same header.
 */
const decisionsByRequest = new WeakMap<
  Request,
  ClientRevalidationDecisions | null
>();

function clientDecisionsFor(
  request: Request | undefined,
): ClientRevalidationDecisions | null {
  if (!request) return null;
  if (decisionsByRequest.has(request)) {
    return decisionsByRequest.get(request) ?? null;
  }
  const decoded = decodeClientRevalidationDecisions(
    request.headers.get(CLIENT_REVALIDATION_HEADER),
  );
  decisionsByRequest.set(request, decoded);
  return decoded;
}

/**
 * The server end of client-run per-loader revalidation: clientUrls()
 * revalidate() predicates EXECUTE in the browser (they are client-module
 * code), and their decisions arrive on the request header. This synthesized
 * predicate — attached to every materialized loader stub — honors a decision
 * addressed to its loader id and otherwise returns the locked default, which
 * is also the behavior for requests that carry no decisions (no-JS, PE,
 * prefetch, document loads). Decisions can only address client-urls stubs;
 * server-tree loaders never see this predicate.
 */
function makeClientDecisionRevalidate(
  loaderId: string,
): (args: {
  defaultShouldRevalidate: boolean;
  context: { request: Request };
}) => boolean {
  return ({ defaultShouldRevalidate, context }) => {
    const decisions = clientDecisionsFor(context?.request);
    if (decisions) {
      if (decisions.skip.includes(loaderId)) return false;
      if (decisions.force.includes(loaderId)) return true;
    }
    return defaultShouldRevalidate;
  };
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

function materializedPathOptions(route: ClientUrlProjectionRoute): PathOptions {
  return {
    ...(route.name === null ? {} : { name: route.name }),
    ...(route.options.search ? { search: { ...route.options.search } } : {}),
    ...(route.options.trailingSlash
      ? { trailingSlash: route.options.trailingSlash }
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

  // Helper calls attach to the CURRENT ctx.parent as they execute, so these
  // builders must run where the items belong: at the module top level for the
  // flat (no-intercept) shape, or inside the group layout's children callback
  // when intercepts wrap the group.
  const buildRouteItems = (): AllUseItems[] =>
    projection.routes.map(
      (route) =>
        path(
          route.pattern,
          () =>
            React.createElement(ClientUrlsRoot, {
              definition: reference as ClientUrlPatterns,
              routeId: route.id,
              namePrefix,
            }),
          materializedPathOptions(route),
          () => [
            ...route.loaderIds.map((id, loaderIndex) =>
              loader(
                createLoaderStub(id),
                route.awaitedLoaderIndices?.includes(loaderIndex)
                  ? { stream: "navigation" }
                  : undefined,
                () => [revalidate(makeClientDecisionRevalidate(id))],
              ),
            ),
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
            // Data-only per-route transition config: same child position as a
            // hand-written server transition(config) — no `when`.
            ...(route.transition ? [transition({ ...route.transition })] : []),
          ],
        ) as AllUseItems,
    );

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
      : from.pathname === mount || from.pathname.startsWith(`${mount}/`);
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
          "Vite discovery pass can project it; in unit tests pass the clientUrls() object directly.",
      );
    }
    return materializeRouteItems(source, projection, helpers);
  });
}
