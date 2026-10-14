import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { normalizePath, parseAst, type EnvironmentModuleNode } from "vite";
import {
  projectClientUrlsModule,
  type ClientUrlProjection,
} from "../../client-urls/server-projection.js";
import {
  computeProductionHash,
  hashRefKey,
} from "../plugins/client-ref-hashing.js";
import { hasUseClientDirective } from "../utils/directive-prologue.js";
import { firstCodeMatchIndex } from "../../build/route-types/source-scan.js";
import { parseLang } from "../plugins/hoist/literal.js";
import type { Node } from "../plugins/hoist/scope.js";
import { createRangoDebugger, NS } from "../debug.js";
import { findTsFiles } from "../../build/route-types/scan-filter.js";
import type { DiscoveryState } from "./state.js";

const debug = createRangoDebugger(NS.discovery);

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

/** The RSC environment whose realm `ClientUrlProjectionServerModule` is. */
interface ClientUrlRscEnvironment {
  readonly runner: { import(id: string): Promise<unknown> };
  readonly moduleGraph?: {
    getModuleById(id: string): EnvironmentModuleNode | undefined;
    invalidateModule(mod: EnvironmentModuleNode): void;
  };
}

export const CLIENT_URLS_REVALIDATE_QUERY = "rango-revalidate";

/** The id of the module registering `file`'s hoisted revalidate() predicates. */
export function hoistedRevalidateId(file: string): string {
  return `${file}?${CLIENT_URLS_REVALIDATE_QUERY}`;
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

/** A module that imports the router's client entry (a cheap pre-filter). */
export const CLIENT_IMPORT_RE: RegExp = /["']@rangojs\/router\/client["']/;

/**
 * Whether an edited module can carry a clientUrls() component's own items: it
 * imports "@rangojs/router/client" and assigns a `.use` in code (not in a
 * comment or string). Such a module changes its groups' projections and
 * hoisted revalidate() registrations like a group edit, with or without
 * "use client".
 */
export function isClientUrlsComponentUseSource(source: string): boolean {
  return (
    source.includes(".use") &&
    CLIENT_IMPORT_RE.test(source) &&
    firstCodeMatchIndex(source, /\.use\s*=(?!=)/g) >= 0
  );
}

/**
 * A hash of the text of every `X.use = ...` assignment of a component-use
 * module (isClientUrlsComponentUseSource), or undefined for any other module.
 * Equal before and after a save, the edit (markup, hooks) left what its
 * groups read unchanged: the dev watcher skips re-discovery and the client
 * keeps Fast Refresh. An edit outside the assignments that changes what one
 * means (a helper it calls, an import's source) is not seen. A module that
 * does not parse hashes whole.
 */
export function componentUseSignature(
  source: string,
  file: string,
): string | undefined {
  if (!isClientUrlsComponentUseSource(source)) return undefined;
  const hash = createHash("sha256");
  let program: Node;
  try {
    program = parseAst(source, { lang: parseLang(file) });
  } catch {
    return hash.update(source).digest("base64");
  }
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const { type, left } = node as Node;
    if (
      type === "AssignmentExpression" &&
      left.type === "MemberExpression" &&
      !left.computed &&
      left.property.type === "Identifier" &&
      left.property.name === "use"
    ) {
      const { start, end } = node as Node;
      hash.update(source.slice(start, end)).update("\0");
      return;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(program.body);
  return hash.digest("base64");
}

export function resolveClientUrlsSource(
  state: DiscoveryState,
  referenceId: string,
): string | undefined {
  return state.clientUrlSourceByReferenceId?.get(
    withoutReferenceQuery(referenceId),
  );
}

/**
 * Deterministic filesystem discovery of clientUrls modules. Transform-based
 * recording only sees modules that some environment actually loads — a
 * clientUrls module not yet reachable from any transformed graph at discovery
 * time (cold ordering, a mount added before its first import is served) would
 * never be recorded and its include would fail with empty projections. Walking
 * the project source (the same walk static route-type generation performs)
 * makes recording independent of module-graph timing. The transform hooks
 * still record too — they refresh dev HMR edits between scans.
 */
export function scanForClientUrlModules(state: DiscoveryState): void {
  if (!state.projectRoot) return;
  for (const filePath of findTsFiles(state.projectRoot, state.scanFilter)) {
    let code: string;
    try {
      code = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    recordClientUrlsModule(state, code, filePath);
  }
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
 * last-known projection), and all refreshed projections keep their
 * last-known state when any registration fails to load; the strict
 * discoverClientUrlProjections() pass still surfaces real failures afterwards.
 * No-ops on cold start (nothing recorded yet) and when the SSR runner is
 * unavailable.
 */
export async function refreshRecordedClientUrlProjections(
  state: DiscoveryState,
  ssrEnv: ClientUrlSsrEnvironment | undefined,
  serverMod: ClientUrlProjectionServerModule,
  rscEnv: ClientUrlRscEnvironment,
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

  const refreshed = new Map<string, ClientUrlProjection>();
  for (const [source, referenceIds] of referenceIdsBySource) {
    let module: Record<string, unknown>;
    try {
      module = await ssrEnv.runner.import(source);
    } catch {
      continue;
    }
    let projection: ClientUrlProjection | undefined;
    try {
      projection = projectClientUrlsModule(module, { hoisted: true });
    } catch {
      continue;
    }
    if (!projection) continue;
    debug?.(
      "pre-entry refresh %s -> [%s]",
      source,
      projection.routes.map((route) => route.pattern).join(", "),
    );
    for (const referenceId of referenceIds) {
      refreshed.set(referenceId, projection);
    }
  }
  if (refreshed.size === 0) return;
  // The eager routes-manifest virtual module REPLAYS the state map
  // (clearClientUrlProjections + set) whenever it re-evaluates — and the
  // watcher's gen-file write invalidates it right before the entry import, so
  // a stale map would clobber the registry install before the router
  // materializes its mount: the install keeps both in sync.
  try {
    await installClientUrlProjections(
      state,
      rscEnv,
      serverMod,
      refreshed,
      false,
    );
  } catch (error) {
    debug?.(
      "pre-entry refresh: predicate registrations failed to load: %s",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Strict projection discovery over every RECORDED clientUrls module. Recorded
 * modules — not router references — are the source of truth: include() mounts
 * materialize lazily from the projection registry, so there is no router-level
 * reference list to consult. Serializes every source before atomically
 * installing the new projections (a failure preserves last-known state).
 *
 * A recorded source whose file no longer exists is dropped silently
 * (recordClientUrlsModule never un-records, so deletions must self-heal here).
 * A present-but-broken module is a hard error: it is part of the app graph.
 */
export async function discoverClientUrlProjections(
  state: DiscoveryState,
  ssrEnv: ClientUrlSsrEnvironment | undefined,
  serverMod: ClientUrlProjectionServerModule,
  rscEnv: ClientUrlRscEnvironment,
): Promise<void> {
  scanForClientUrlModules(state);
  const sourceByReferenceId = state.clientUrlSourceByReferenceId;
  if (!sourceByReferenceId?.size) {
    await installClientUrlProjections(
      state,
      rscEnv,
      serverMod,
      new Map(),
      true,
    );
    return;
  }

  const referenceIdsBySource = new Map<string, string[]>();
  for (const [referenceId, source] of sourceByReferenceId) {
    const ids = referenceIdsBySource.get(source);
    if (ids) {
      ids.push(referenceId);
    } else {
      referenceIdsBySource.set(source, [referenceId]);
    }
  }

  if (typeof ssrEnv?.runner?.import !== "function") {
    const [source, ids] = referenceIdsBySource.entries().next().value as [
      string,
      string[],
    ];
    throw projectionError(
      ids[0],
      source,
      "the SSR module runner is unavailable",
    );
  }

  const nextProjections = new Map<string, ClientUrlProjection>();
  const removedSources: string[] = [];
  for (const [source, referenceIds] of referenceIdsBySource) {
    let module: Record<string, unknown>;
    try {
      module = await ssrEnv.runner.import(source);
    } catch (cause) {
      if (!existsSync(source)) {
        removedSources.push(source);
        continue;
      }
      throw projectionError(
        referenceIds[0],
        source,
        "failed to import the source module",
        cause,
      );
    }
    let projection: ClientUrlProjection | undefined;
    try {
      projection = projectClientUrlsModule(module, { hoisted: true });
    } catch (cause) {
      throw projectionError(
        referenceIds[0],
        source,
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );
    }
    if (!projection) {
      throw projectionError(
        referenceIds[0],
        source,
        'the module default export must be created by clientUrls() and have __brand === "client-urls"',
      );
    }
    for (const referenceId of referenceIds) {
      nextProjections.set(referenceId, projection);
    }
  }

  for (const source of removedSources) {
    for (const [referenceId, recorded] of sourceByReferenceId) {
      if (recorded === source) sourceByReferenceId.delete(referenceId);
    }
  }

  await installClientUrlProjections(
    state,
    rscEnv,
    serverMod,
    nextProjections,
    true,
  );
}

/**
 * Install `projections` in the realm of `serverMod` and in `state` (all of
 * them with `replace`, else over the installed ones), once `rscEnv` has
 * loaded the registrations of every revalidate() key they read
 * (assignClientUrlRevalidateFiles). Node dev serves requests in that realm,
 * and a request materializes the installed projection, so a key whose
 * registration has not loaded must never be installed.
 */
async function installClientUrlProjections(
  state: DiscoveryState,
  rscEnv: ClientUrlRscEnvironment,
  serverMod: ClientUrlProjectionServerModule,
  projections: ReadonlyMap<string, ClientUrlProjection>,
  replace: boolean,
): Promise<void> {
  const next = new Map(replace ? undefined : state.clientUrlProjectionMap);
  for (const [id, projection] of projections) next.set(id, projection);
  await assignClientUrlRevalidateFiles(state, rscEnv, next);
  if (replace) serverMod.clearClientUrlProjections();
  for (const [id, projection] of projections) {
    serverMod.setClientUrlProjection(id, projection);
  }
  state.clientUrlProjectionMap = next;
}

/**
 * Assign each group of `projections` the other files holding the predicates
 * it reads (each key's file, as the hoist transform recorded it: a key with
 * none stays unregistered, and materialization names it), after loading their
 * registrations into `rscEnv`. The group's own registrations load with its
 * proxy, and its `?rango-revalidate` module imports the assigned files'
 * (plugins/client-urls-revalidate-hoist.ts). When a group's files change, that
 * module is invalidated, so a later evaluation (a reload, a request realm)
 * imports the current ones. Another realm (workerd, a production bundle)
 * loads a group only after discovery: its entry imports the routes-manifest
 * module first, whose load waits for discovery (RSC_ENTRY_BOOTSTRAP_IMPORTS),
 * and a build discovers in buildStart.
 */
export async function assignClientUrlRevalidateFiles(
  state: Pick<
    DiscoveryState,
    "clientUrlRevalidate" | "clientUrlSourceByReferenceId"
  >,
  rscEnv: ClientUrlRscEnvironment,
  projections: ReadonlyMap<string, ClientUrlProjection>,
): Promise<void> {
  const { fileByKey, filesByGroup } = state.clientUrlRevalidate;
  const next = new Map<string, readonly string[]>();
  for (const [referenceId, projection] of projections) {
    const group = state.clientUrlSourceByReferenceId?.get(referenceId);
    if (group === undefined || next.has(group)) continue;
    const files = new Set<string>();
    for (const owner of [
      ...projection.routes,
      ...(projection.intercepts ?? []),
    ]) {
      for (const key of owner.loaderRevalidate?.flat() ?? []) {
        const file = typeof key === "string" ? fileByKey.get(key) : undefined;
        if (file !== undefined && file !== group) files.add(file);
      }
    }
    next.set(group, [...files].sort());
  }
  await Promise.all(
    [...new Set([...next.values()].flat())].map((file) =>
      rscEnv.runner.import(hoistedRevalidateId(file)),
    ),
  );
  const graph = rscEnv.moduleGraph;
  for (const [group, files] of next) {
    if ((filesByGroup.get(group) ?? []).join("\0") === files.join("\0")) {
      continue;
    }
    const mod = graph?.getModuleById(hoistedRevalidateId(group));
    if (graph && mod) graph.invalidateModule(mod);
  }
  filesByGroup.clear();
  for (const [group, files] of next) filesByGroup.set(group, files);
}
