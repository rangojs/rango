import * as React from "react";
import type { SearchSchemaValue } from "../search-params.js";
import { getLoaderLazy } from "../server/loader-registry.js";
import type { LoaderDefinition, TrailingSlashMode } from "../types.js";
import type { PathOptions, UrlPatterns } from "../urls/pattern-types.js";
import { urls } from "../urls/urls-function.js";
import { ClientUrlsLoading, ClientUrlsRoot } from "./client-root.js";
import type { ClientUrlPatterns, ClientUrlRouteRecord } from "./types.js";

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
const projectionListeners = new Set<(referenceId: string) => void>();

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
}

export interface ClientUrlProjection {
  readonly version: 1;
  readonly routes: readonly ClientUrlProjectionRoute[];
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

  return Object.freeze({
    id: route.id,
    pattern: route.pattern,
    name: route.name ?? null,
    options: serializeOptions(route),
    loaderIds: Object.freeze(loaderIds),
    hasLoading: route.loading !== undefined,
  });
}

export function serializeClientUrlPatterns(
  patterns: ClientUrlPatterns,
): ClientUrlProjection {
  return Object.freeze({
    version: 1 as const,
    routes: Object.freeze(patterns.routes.map(serializeRoute)),
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

function projectionKey(reference: string | ClientUrlReference): string {
  if (typeof reference === "string" && reference.length > 0) return reference;
  if (isClientUrlReference(reference)) return reference.$$id;
  throw new Error(
    "Client URL projections require a React client reference with a non-empty $$id",
  );
}

export function setClientUrlProjection(
  reference: string | ClientUrlReference,
  projection: ClientUrlProjection,
): void {
  const key = projectionKey(reference);
  clientUrlProjections.set(key, projection);
  for (const listener of projectionListeners) listener(key);
}

export function getClientUrlProjection(
  reference: string | ClientUrlReference,
): ClientUrlProjection | undefined {
  return clientUrlProjections.get(projectionKey(reference));
}

export function clearClientUrlProjections(): void {
  clientUrlProjections.clear();
}

export function subscribeClientUrlProjections(
  listener: (referenceId: string) => void,
): () => void {
  projectionListeners.add(listener);
  return () => projectionListeners.delete(listener);
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

export function materializeClientUrlPatterns(
  reference: ClientUrlDefinitionSource,
  projection: ClientUrlProjection,
): UrlPatterns {
  if (!isClientUrlReference(reference) && !isClientUrlPatterns(reference)) {
    throw new Error(
      "materializeClientUrlPatterns() expects clientUrls() patterns or a React client reference with a non-empty $$id",
    );
  }

  return urls(({ path, loader, loading }) =>
    projection.routes.map((route) =>
      path(
        route.pattern,
        () =>
          React.createElement(ClientUrlsRoot, {
            definition: reference as ClientUrlPatterns,
            routeId: route.id,
          }),
        materializedPathOptions(route),
        () => [
          ...route.loaderIds.map((id) => loader(createLoaderStub(id))),
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
        ],
      ),
    ),
  );
}
