import { isAbsolute, relative, resolve } from "node:path";
import { normalizePath, parseAst } from "vite";
import {
  serializeClientUrlPatterns,
  type ClientUrlProjection,
} from "../../client-urls/server-projection.js";
import type { ClientUrlPatterns } from "../../client-urls/types.js";
import {
  computeProductionHash,
  hashRefKey,
} from "../plugins/client-ref-hashing.js";
import { hasUseClientDirective } from "../utils/directive-prologue.js";
import { createRangoDebugger, NS } from "../debug.js";
import type { DiscoveryState } from "./state.js";

const debug = createRangoDebugger(NS.discovery);

interface ClientUrlReferenceLike {
  readonly $$id: string;
}

interface ClientUrlRouterLike {
  readonly __clientUrlReferences?: readonly ClientUrlReferenceLike[];
}

interface ClientUrlSsrEnvironment {
  readonly runner?: {
    import(id: string): Promise<Record<string, unknown>>;
  };
}

interface ClientUrlProjectionServerModule {
  clearClientUrlProjections(): void;
  setClientUrlProjection(
    referenceId: string,
    projection: ClientUrlProjection,
  ): void;
}

function hasDefaultExport(code: string): boolean {
  let program: { body?: any[] };
  try {
    program = parseAst(code, { lang: "tsx" }) as { body?: any[] };
  } catch {
    return false;
  }

  for (const node of program.body ?? []) {
    if (node?.type === "ExportDefaultDeclaration") return true;
    if (node?.type !== "ExportNamedDeclaration") continue;
    for (const specifier of node.specifiers ?? []) {
      const exportedName =
        specifier?.exported?.name ?? specifier?.exported?.value;
      if (exportedName === "default") return true;
    }
  }
  return false;
}

function normalizeSource(state: DiscoveryState, id: string): string {
  const cleanId = id.split("?", 1)[0];
  const absoluteId = isAbsolute(cleanId)
    ? cleanId
    : resolve(state.projectRoot, cleanId);
  return normalizePath(absoluteId);
}

function referenceId(referenceKey: string): string {
  return `${referenceKey}#default`;
}

function withoutReferenceQuery(reference: string): string {
  const exportIndex = reference.lastIndexOf("#");
  const moduleId =
    exportIndex === -1 ? reference : reference.slice(0, exportIndex);
  const exportName = exportIndex === -1 ? "" : reference.slice(exportIndex);
  const queryIndex = moduleId.indexOf("?");
  return `${queryIndex === -1 ? moduleId : moduleId.slice(0, queryIndex)}${exportName}`;
}

export function recordClientUrlsModule(
  state: DiscoveryState,
  code: string,
  id: string,
): void {
  if (
    !code.includes("clientUrls(") ||
    !hasUseClientDirective(code) ||
    !hasDefaultExport(code)
  ) {
    return;
  }

  const source = normalizeSource(state, id);
  const projectRoot = normalizePath(resolve(state.projectRoot));
  const relativeId = normalizePath(relative(projectRoot, source));
  const outsideProject =
    relativeId === ".." ||
    relativeId.startsWith("../") ||
    isAbsolute(relativeId);
  const devReferenceKey = outsideProject ? `/@fs${source}` : `/${relativeId}`;

  const sourceByReferenceId = (state.clientUrlSourceByReferenceId ??=
    new Map());
  sourceByReferenceId.set(referenceId(devReferenceKey), source);

  const productionReferenceKeys = new Set([
    hashRefKey(relativeId),
    computeProductionHash(projectRoot, devReferenceKey),
  ]);
  for (const productionReferenceKey of productionReferenceKeys) {
    sourceByReferenceId.set(referenceId(productionReferenceKey), source);
  }
}

export function resolveClientUrlsSource(
  state: DiscoveryState,
  referenceId: string,
): string | undefined {
  return state.clientUrlSourceByReferenceId?.get(
    withoutReferenceQuery(referenceId),
  );
}

function collectReferenceIds(
  registry: ReadonlyMap<string, ClientUrlRouterLike>,
): string[] {
  const referenceIds = new Set<string>();
  for (const router of registry.values()) {
    for (const reference of router.__clientUrlReferences ?? []) {
      referenceIds.add(reference.$$id);
    }
  }
  return [...referenceIds];
}

function projectionError(
  referenceId: string,
  source: string | undefined,
  message: string,
  cause?: unknown,
): Error {
  const sourceDescription = source ? ` from source "${source}"` : "";
  const errorMessage = `Cannot discover client URL projection for reference "${referenceId}"${sourceDescription}: ${message}`;
  return cause === undefined
    ? new Error(errorMessage)
    : new Error(errorMessage, { cause });
}

/**
 * Lenient pre-entry projection refresh. Re-serializes every RECORDED clientUrls
 * module before the discovery pass imports the entry, so routers re-created by
 * that import materialize against the CURRENT module contents.
 *
 * Scar: node-preset HMR served stale client-urls routes after a route-shape
 * edit — the clientUrls module is an HMR-accepted client boundary in the rsc
 * graph, and the strict registry-driven pass below only runs AFTER the entry
 * import, so `.routes(reference)` materialized the previous pass's projection.
 *
 * Errors are deliberately swallowed per source (a module mid-edit keeps its
 * last-known projection); the strict discoverClientUrlProjections() pass still
 * surfaces real failures afterwards. No-ops on cold start (nothing recorded
 * yet) and when the SSR runner is unavailable.
 */
export async function refreshRecordedClientUrlProjections(
  state: DiscoveryState,
  ssrEnv: ClientUrlSsrEnvironment | undefined,
  serverMod: ClientUrlProjectionServerModule,
): Promise<void> {
  const sourceByReferenceId = state.clientUrlSourceByReferenceId;
  if (
    !sourceByReferenceId?.size ||
    typeof ssrEnv?.runner?.import !== "function"
  ) {
    return;
  }

  const referenceIdsBySource = new Map<string, string[]>();
  for (const [refId, source] of sourceByReferenceId) {
    const ids = referenceIdsBySource.get(source);
    if (ids) {
      ids.push(refId);
    } else {
      referenceIdsBySource.set(source, [refId]);
    }
  }

  for (const [source, referenceIds] of referenceIdsBySource) {
    let definition: unknown;
    try {
      definition = (await ssrEnv.runner.import(source)).default;
    } catch {
      continue;
    }
    if (
      (typeof definition !== "object" && typeof definition !== "function") ||
      definition === null ||
      (definition as { __brand?: unknown }).__brand !== "client-urls"
    ) {
      continue;
    }
    const projection = serializeClientUrlPatterns(
      definition as ClientUrlPatterns,
    );
    debug?.(
      "pre-entry refresh %s -> [%s]",
      source,
      projection.routes.map((route) => route.pattern).join(", "),
    );
    for (const referenceId of referenceIds) {
      serverMod.setClientUrlProjection(referenceId, projection);
      // The eager routes-manifest virtual module REPLAYS this state map
      // (clearClientUrlProjections + set) whenever it re-evaluates — and the
      // watcher's gen-file write invalidates it right before the entry import,
      // so a stale map here would clobber the registry install above before
      // the router materializes its mount. Keep both in sync.
      state.clientUrlProjectionMap?.set(referenceId, projection);
    }
  }
}

export async function discoverClientUrlProjections(
  state: DiscoveryState,
  ssrEnv: ClientUrlSsrEnvironment | undefined,
  serverMod: ClientUrlProjectionServerModule,
  registry: ReadonlyMap<string, ClientUrlRouterLike>,
): Promise<void> {
  const referenceIds = collectReferenceIds(registry);
  const sources = referenceIds.map((id) => {
    const source = resolveClientUrlsSource(state, id);
    if (!source) {
      throw projectionError(id, undefined, "no source module was recorded");
    }
    return { id, source };
  });

  if (sources.length > 0 && typeof ssrEnv?.runner?.import !== "function") {
    const first = sources[0];
    throw projectionError(
      first.id,
      first.source,
      "the SSR module runner is unavailable",
    );
  }

  const nextProjections = new Map<string, ClientUrlProjection>();
  for (const { id, source } of sources) {
    let module: Record<string, unknown>;
    try {
      module = await ssrEnv!.runner!.import(source);
    } catch (cause) {
      throw projectionError(
        id,
        source,
        "failed to import the source module",
        cause,
      );
    }
    const definition = module.default;
    if (
      (typeof definition !== "object" && typeof definition !== "function") ||
      definition === null ||
      (definition as { __brand?: unknown }).__brand !== "client-urls"
    ) {
      throw projectionError(
        id,
        source,
        'the module default export must be created by clientUrls() and have __brand === "client-urls"',
      );
    }
    nextProjections.set(
      id,
      serializeClientUrlPatterns(definition as ClientUrlPatterns),
    );
  }

  serverMod.clearClientUrlProjections();
  for (const [id, projection] of nextProjections) {
    serverMod.setClientUrlProjection(id, projection);
  }
  state.clientUrlProjectionMap = nextProjections;
}
