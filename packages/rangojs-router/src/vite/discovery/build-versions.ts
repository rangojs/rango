/**
 * Per-router cache versions, computed from the built server output.
 *
 * Every cache key and stored PPR shell is tied to a version. A router's
 * versions are hashes of the code that router can run, so the same code gives
 * the same versions and a new deployment finds the entries the previous one
 * wrote. Design and measurements: docs/design/per-app-cache-version.md.
 *
 * Two steps, both pure over data the build hooks record:
 *
 * 1. Membership ({@link resolveRouterMembers}): which server modules can a
 *    router run. Walked on the MODULE graph, not the chunk graph, because the
 *    build has registries that name every app's code (plugin-rsc's
 *    server-reference map, the loader manifest, the routes manifest). A walk
 *    that followed them would put every router's code in every router's set.
 * 2. Hashing ({@link computeRouterVersions}): the bytes on disk of the chunks
 *    holding those modules, read AFTER postprocessBundle rewrote them, with
 *    everything taken out that says where or how the build ran instead of what
 *    it built ({@link digestBundle}).
 *
 * One rule covers what the build cannot determine (a file it lists and cannot
 * read, an import it cannot resolve): the build fails, or the version changes
 * on every build. A version never silently stays the same.
 */

import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import { posix, relative } from "node:path";
import {
  DEFAULT_ROUTER_VERSIONS_KEY,
  type RouterVersionsTable,
} from "../../router-versions.js";
import { escapeRegExp } from "../../regex-escape.js";
import {
  ROUTER_VERSIONS_PLACEHOLDER,
  VIRTUAL_IDS,
} from "../plugins/virtual-entries.js";
import { CLIENT_REFERENCES_MODULE_ID } from "../utils/client-chunks.js";
import { compareStrings } from "../utils/compare-strings.js";
import {
  VIRTUAL_LOADER_MANIFEST_ID,
  VIRTUAL_ROUTES_MANIFEST_ID,
} from "./state.js";

/** Import edges of one module, as the bundler resolved them. */
export interface BuildModuleEdges {
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
  /**
   * The module encrypts inline-action bound arguments, so what it renders can
   * only be decrypted with the build's encryption key.
   */
  readonly encryptsBoundArgs?: boolean;
}

export interface BuildChunk {
  readonly fileName: string;
  /** The chunk's name without its content hash. */
  readonly name: string;
  readonly moduleIds: readonly string[];
  /** Specifiers the chunk imports that the bundle does not contain. */
  readonly externalImports?: readonly string[];
}

export interface BuildAsset {
  readonly fileName: string;
  /** The asset's name without its content hash. */
  readonly name: string;
}

/** The files one environment's bundle emits. */
export interface BundleFiles {
  readonly chunks: readonly BuildChunk[];
  readonly assets: readonly BuildAsset[];
}

/** The RSC environment's bundle, from its real (not scan) build pass. */
export interface ServerBuildGraph extends BundleFiles {
  readonly modules: ReadonlyMap<string, BuildModuleEdges>;
}

/** The client environment's module graph and emitted file names. */
export interface ClientBuildGraph {
  readonly modules: ReadonlyMap<string, BuildModuleEdges>;
  readonly fileNames: readonly string[];
}

/** One discovered router: its runtime id and the module that creates it. */
export interface RouterSource {
  readonly id: string;
  /** Absolute path of the file calling createRouter(), when known. */
  readonly moduleId: string | undefined;
}

/**
 * One piece of data the build produced that a router's output depends on and
 * that none of the router's chunks holds. Named by the digest of its bytes.
 *
 * The kinds feed different versions, by where the data can end up at run
 * time:
 *
 * - A Static payload is a segment of an ordinary route, so a `cache()` entry
 *   of that route stores it. It is part of the DATA version.
 * - A clientUrls() projection is what the server materializes a client-defined
 *   route group from: its loaders, loading states, transitions and route ids.
 *   It ships in the routes registry (virtual-module-codegen.ts), which a
 *   lazily mounted app's chunks do not include. DATA version.
 * - A server component's stylesheet URLs are read at run time from plugin-rsc's
 *   assets manifest and rendered as `<link>`s into the router's Flight, so
 *   they are in cached payloads while no server chunk holds them. DATA version.
 * - A Prerender payload is served from the build's own store and never
 *   written to the segment cache (withCacheLookup returns before the cache
 *   scope, match-middleware/cache-lookup.ts). Only stored HTML holds it: a PPR
 *   shell or a document-cache response of the route. It is part of the
 *   DOCUMENT version only.
 */
export interface BuildDataRecord {
  readonly kind: "prerender" | "static" | "client-urls" | "server-css";
  /**
   * Prerender manifest key, Static handler id, clientUrls() module, or the
   * module a `serverResources` entry is keyed by.
   */
  readonly key: string;
  /** sha256 of the payload, the projection, or the entry. */
  readonly digest: string;
  /** Router that rendered it (prerender). */
  readonly routerId?: string;
  /**
   * Module the data belongs to (static: the handler's; client-urls: the
   * clientUrls() module; server-css: the module that renders the links).
   * Owned by {@link ownersOf}.
   */
  readonly moduleId?: string;
}

export interface RouterMembers {
  /** Server modules the router can run. */
  readonly modules: ReadonlySet<string>;
  /** Chunk files holding any of them, plus the router's route manifest. */
  readonly chunkFiles: ReadonlySet<string>;
}

/** The slice of a plugin context the graph recorders read. */
interface ModuleGraphContext {
  getModuleIds(): Iterable<string>;
  getModuleInfo(id: string): {
    importedIds?: readonly string[];
    dynamicallyImportedIds?: readonly string[];
    code?: string | null;
  } | null;
}

/** The slice of an output bundle the graph recorders read. */
type OutputBundleLike = Record<
  string,
  {
    type: string;
    fileName: string;
    name?: string;
    names?: readonly string[];
    moduleIds?: readonly string[];
    imports?: readonly string[];
    dynamicImports?: readonly string[];
  }
>;

function identifier(name: string): RegExp {
  return new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "g");
}

const ENCRYPTION_RUNTIME_ID = "/utils/encryption-runtime";
/** plugin-rsc 0.5.35 imports its encryption runtime as a namespace. */
const ENCRYPTION_RUNTIME_IMPORT =
  /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*["'][^"'\n]*\/utils\/encryption-runtime[^"'\n]*["']/;

/**
 * Whether a module that imports plugin-rsc's encryption runtime uses it.
 *
 * plugin-rsc prepends the import to every `"use server"` module it transforms
 * and calls the runtime only where an inline action closes over a value, so
 * the import alone is not a sign that a module encrypts. The test is any use
 * of the namespace the import binds, not the name of the function called: a
 * rename in plugin-rsc must not take the key out of the versions. A module
 * whose code or import this cannot read counts as using it.
 */
function usesEncryptionRuntime(code: string | null | undefined): boolean {
  if (code == null) return true;
  const local = code.match(ENCRYPTION_RUNTIME_IMPORT)?.[1];
  if (local === undefined) return true;
  // The import statement itself is the first occurrence.
  let occurrences = 0;
  for (const _ of code.matchAll(identifier(local))) {
    if (++occurrences > 1) return true;
  }
  return false;
}

function recordModuleEdges(
  context: ModuleGraphContext,
): Map<string, BuildModuleEdges> {
  const modules = new Map<string, BuildModuleEdges>();
  for (const id of context.getModuleIds()) {
    const info = context.getModuleInfo(id);
    const imports = info?.importedIds ?? [];
    // `code` is read only for the few modules that import the runtime.
    const encryptsBoundArgs =
      imports.some((imported) => imported.includes(ENCRYPTION_RUNTIME_ID)) &&
      usesEncryptionRuntime(info?.code);
    modules.set(id, {
      imports,
      dynamicImports: info?.dynamicallyImportedIds ?? [],
      ...(encryptsBoundArgs ? { encryptsBoundArgs } : undefined),
    });
  }
  return modules;
}

/** The chunks and assets of a bundle. Call from generateBundle. */
export function recordBundleFiles(bundle: OutputBundleLike): BundleFiles {
  const chunks: BuildChunk[] = [];
  const assets: BuildAsset[] = [];
  for (const file of Object.values(bundle)) {
    if (file.type === "chunk") {
      chunks.push({
        fileName: file.fileName,
        name: file.name ?? file.fileName,
        moduleIds: file.moduleIds ?? [],
        externalImports: [
          ...(file.imports ?? []),
          ...(file.dynamicImports ?? []),
        ].filter((specifier) => !Object.hasOwn(bundle, specifier)),
      });
    } else {
      assets.push({
        fileName: file.fileName,
        name: file.names?.[0] ?? file.fileName,
      });
    }
  }
  return { chunks, assets };
}

/** Call from the RSC environment's generateBundle. */
export function recordServerGraph(
  context: ModuleGraphContext,
  bundle: OutputBundleLike,
): ServerBuildGraph {
  return { modules: recordModuleEdges(context), ...recordBundleFiles(bundle) };
}

/** Call from the client environment's generateBundle. */
export function recordClientGraph(
  context: ModuleGraphContext,
  bundle: OutputBundleLike,
): ClientBuildGraph {
  return {
    modules: recordModuleEdges(context),
    fileNames: Object.values(bundle).map((file) => file.fileName),
  };
}

/** plugin-rsc's build-time map of every server reference in the app. */
export const SERVER_REFERENCES_MODULE_ID =
  "\0virtual:vite-rsc/server-references";
const LOADER_REGISTRY = "\0" + VIRTUAL_LOADER_MANIFEST_ID;
const ROUTES_REGISTRY = "\0" + VIRTUAL_ROUTES_MANIFEST_ID;
const VERSION_MODULE = "\0" + VIRTUAL_IDS.version;

/**
 * plugin-rsc writes the key to this file next to the RSC entry and has chunks
 * import it at run time (its `rsc:encryption-key` renderChunk), so the key is
 * in no chunk and in no bundle graph. The file exists only when a rendered
 * chunk reads the key.
 */
export const ENCRYPTION_KEY_FILE = "__vite_rsc_encryption_key.js";

/**
 * Modules that enumerate build-wide references and import each one. The walk
 * stops at them: what they point to belongs to whichever router reaches it by
 * its own imports, or through a client component it renders
 * (resolveRouterMembers).
 */
function isRegistryModule(id: string): boolean {
  return (
    id === SERVER_REFERENCES_MODULE_ID ||
    id === LOADER_REGISTRY ||
    id === ROUTES_REGISTRY ||
    id.startsWith(ROUTES_REGISTRY + "/") ||
    id === CLIENT_REFERENCES_MODULE_ID ||
    id.startsWith(CLIENT_REFERENCES_MODULE_ID + "/")
  );
}

function routeManifestModuleId(routerId: string): string {
  return `${ROUTES_REGISTRY}/${routerId}`;
}

function walk(
  modules: ReadonlyMap<string, BuildModuleEdges>,
  roots: Iterable<string>,
  reached: Set<string>,
): void {
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    if (isRegistryModule(id)) continue;
    const edges = modules.get(id);
    if (!edges) continue;
    for (const next of edges.imports) {
      if (!reached.has(next)) stack.push(next);
    }
    for (const next of edges.dynamicImports) {
      if (!reached.has(next)) stack.push(next);
    }
  }
}

/** Server actions and loaders the build registries point at. */
function registryTargets(server: ServerBuildGraph): Set<string> {
  const targets = new Set<string>();
  for (const id of [SERVER_REFERENCES_MODULE_ID, LOADER_REGISTRY]) {
    for (const target of server.modules.get(id)?.dynamicImports ?? []) {
      targets.add(target);
    }
  }
  return targets;
}

/**
 * The one ownership rule for everything a router's version covers that its
 * own walk does not hand it: a registry target, a build-rendered payload, a
 * clientUrls() projection, a server component's stylesheets, the encryption
 * key. Each has subject modules. It belongs to the routers that reach one of
 * them, and to EVERY router when none does: what no router can be shown to
 * run can still be run through any of them (an action only the browser entry
 * imports, a handler the graph does not show).
 *
 * Returns the owning router ids, or `undefined` for every router.
 */
function ownersOf(
  subjects: readonly string[],
  reachOf: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> | undefined {
  const owners = new Set<string>();
  for (const [routerId, reached] of reachOf) {
    if (subjects.some((id) => reached.has(id))) owners.add(routerId);
  }
  return owners.size > 0 ? owners : undefined;
}

/** What one router's walk has covered so far, in each graph. */
interface Reach {
  readonly server: Set<string>;
  readonly client: Set<string>;
}

/**
 * Add everything `roots` can run to `reach.server`.
 *
 * A `"use client"` module is a leaf in the server graph (plugin-rsc replaces it
 * with reference proxies), so a server action or loader that only client code
 * imports is not reachable from the router's module there. It is reachable in
 * the CLIENT graph, where the same file imports it as a proxy. So: take every
 * reached module that also exists in the client graph and the client walk has
 * not covered, walk the client graph from it, and add the registry targets
 * found. Repeat until nothing is added, since an action's own imports can
 * render more client components.
 */
function extendReach(
  server: ServerBuildGraph,
  client: ClientBuildGraph | undefined,
  targets: ReadonlySet<string>,
  reach: Reach,
  roots: Iterable<string>,
): void {
  walk(server.modules, roots, reach.server);
  if (!client || targets.size === 0) return;

  for (;;) {
    const seeds: string[] = [];
    for (const id of reach.server) {
      if (!reach.client.has(id) && client.modules.has(id)) seeds.push(id);
    }
    if (seeds.length === 0) return;
    walk(client.modules, seeds, reach.client);
    const found: string[] = [];
    for (const target of targets) {
      if (reach.client.has(target) && !reach.server.has(target)) {
        found.push(target);
      }
    }
    if (found.length === 0) return;
    walk(server.modules, found, reach.server);
  }
}

/** Bundler ids can carry a query; discovery's source path never does. */
function findModuleId(
  modules: ReadonlyMap<string, BuildModuleEdges>,
  path: string,
): string | undefined {
  if (modules.has(path)) return path;
  for (const id of modules.keys()) {
    const query = id.indexOf("?");
    if (query !== -1 && id.slice(0, query) === path) return id;
  }
  return undefined;
}

/** For each module, the modules that statically import it. */
function staticImporters(
  modules: ReadonlyMap<string, BuildModuleEdges>,
): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const [id, edges] of modules) {
    if (isRegistryModule(id)) continue;
    for (const imported of edges.imports) {
      const list = importers.get(imported);
      if (list) list.push(id);
      else importers.set(imported, [id]);
    }
  }
  return importers;
}

/**
 * Work out, per router, the server modules it can run and the chunk files
 * holding them.
 *
 * The walk starts at the module calling createRouter() AND at every module
 * that statically imports it, directly or through other static imports. What
 * runs with a router is not only what its own module imports: the modules
 * importing it attach middleware and handlers (`router.use(...)` in an app
 * module) and wrap its fetch (the mounted handler). The climb stops at a
 * dynamic import, which is how a host mounts an app it does not run with; so
 * routers that one module imports statically share that module's code, and
 * only lazily mounted apps are independent of each other.
 *
 * A router whose module the build cannot find is left out of the result; the
 * runtime then serves it with the whole-build versions
 * ({@link DEFAULT_ROUTER_VERSIONS_KEY}).
 *
 * Membership is per module, the hash is per chunk file. A chunk that holds one
 * reached module is hashed whole, so a router's version also covers whatever
 * the bundler placed next to its code: the conservative direction.
 */
export function resolveRouterMembers(
  server: ServerBuildGraph,
  client: ClientBuildGraph | undefined,
  routers: readonly RouterSource[],
): Map<string, RouterMembers> {
  const targets = registryTargets(server);
  const importers = staticImporters(server.modules);
  const reachByRouter = new Map<string, Reach>();
  for (const router of routers) {
    const moduleId =
      router.moduleId !== undefined
        ? findModuleId(server.modules, router.moduleId)
        : undefined;
    if (moduleId === undefined) continue;
    const climbed = new Set<string>();
    const stack = [moduleId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (climbed.has(id)) continue;
      climbed.add(id);
      for (const importer of importers.get(id) ?? []) stack.push(importer);
    }
    const reach: Reach = { server: new Set(), client: new Set() };
    extendReach(server, client, targets, reach, climbed);
    reachByRouter.set(router.id, reach);
  }

  // A registry target no router reaches (an action only the browser entry
  // imports, a loader nothing imports) is every router's: ownersOf.
  const serverReach = new Map(
    [...reachByRouter].map(([routerId, reach]) => [routerId, reach.server]),
  );
  const unattributed = [...targets].filter(
    (target) => ownersOf([target], serverReach) === undefined,
  );
  if (unattributed.length > 0) {
    for (const reach of reachByRouter.values()) {
      extendReach(server, client, targets, reach, unattributed);
    }
  }

  const chunkOfModule = new Map<string, string>();
  for (const chunk of server.chunks) {
    for (const id of chunk.moduleIds) chunkOfModule.set(id, chunk.fileName);
  }

  const members = new Map<string, RouterMembers>();
  for (const [routerId, { server: modules }] of reachByRouter) {
    const chunkFiles = new Set<string>();
    for (const id of modules) {
      const fileName = chunkOfModule.get(id);
      if (fileName !== undefined) chunkFiles.add(fileName);
    }
    // The lazy route manifest is loaded through the routes registry
    // (ensureRouterManifest), never imported by the router's own code.
    const manifestChunk = chunkOfModule.get(routeManifestModuleId(routerId));
    if (manifestChunk !== undefined) chunkFiles.add(manifestChunk);
    members.set(routerId, { modules, chunkFiles });
  }
  return members;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Bundle file names use `/` on every platform. */
const baseName = posix.basename;

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * A pnpm store directory with its peer suffix:
 * `.pnpm/@vitejs+plugin-rsc@0.5.35_react@19.3.0_<hash>`. The suffix names what
 * the package was installed against, peers of peers included, so bumping any
 * of those (TypeScript is an optional peer of many) renames the directory
 * while the package's own files stay the same.
 */
const PNPM_PEER_SUFFIX = /(\/\.pnpm\/[^/]+?@[^/_]+)_[^/]+(?=\/)/g;

/**
 * plugin-rsc names a client-reference group after the facade module of its
 * server chunk, made relative to the root with `path.relative`. For a virtual
 * facade (@cloudflare/vite-plugin's worker entry) that resolves the id
 * against the WORKING directory first, so the group's module id carries the
 * way from the root to wherever vite was started:
 * `…/group/facade:__/__/\0virtual:cloudflare/worker-entry` from a repository
 * root, `…/group/facade:\0virtual:cloudflare/worker-entry` in the app. Measured
 * on tests/cloudflare-stress-demo: the SSR chunk holding that module got
 * another identity, and the document version with it.
 */
function withoutWorkingDirectory(id: string): string {
  const kind = /(?:facade|shared):/.exec(id);
  const virtual = id.indexOf("\0");
  if (!kind || virtual === -1) return id;
  const facade = kind.index + kind[0].length;
  return virtual < facade ? id : id.slice(0, facade) + id.slice(virtual);
}

/**
 * A module id without the build machine's checkout directory: root-relative
 * inside the project, and from the outermost node_modules for an installed
 * package. The outermost, not the innermost: two installed versions of one
 * package differ only in the directories between (`.pnpm/foo@1…/node_modules/foo`,
 * a nested `a/node_modules/foo`), and must not get the same id. A pnpm store
 * directory is reduced to `name@version` ({@link PNPM_PEER_SUFFIX}).
 *
 * A virtual id can carry a file path in its query. plugin-rsc's server CSS
 * module is `virtual:vite-rsc/css?type=rsc&id=<URI-encoded absolute importer>`,
 * so those values are made portable too.
 */
export function portableModuleId(id: string, projectRoot: string): string {
  const path = id.startsWith("\0") ? id.slice(1) : id;
  const nodeModules = path.indexOf("/node_modules/");
  if (nodeModules !== -1) {
    return path.slice(nodeModules + 1).replace(PNPM_PEER_SUFFIX, "$1");
  }
  if (isAbsolutePath(path)) {
    return relative(projectRoot, path).replaceAll("\\", "/");
  }
  return withoutWorkingDirectory(path).replace(
    /([?&][^=&]+=)([^&]+)/g,
    (whole, name, value) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        return whole;
      }
      return isAbsolutePath(decoded)
        ? name + portableModuleId(decoded, projectRoot)
        : whole;
    },
  );
}

/** plugin-rsc's server CSS module, as a portable id; captures the importer. */
const SERVER_CSS_MODULE = /^virtual:vite-rsc\/css\?type=rsc&id=([^&]+)/;

/** A sourcemap describes a file; it is not code the server runs. */
export function isSourceMap(fileName: string): boolean {
  return fileName.endsWith(".map");
}

/**
 * The bundler's region comments around plugin-rsc's server-reference map, as
 * they appear in an unminified chunk (`\0` is printed as two characters).
 */
const SERVER_REFERENCES_REGION_START = `//#region \\0${SERVER_REFERENCES_MODULE_ID.slice(1)}\n`;
const REGION_END = "//#endregion";

/**
 * Drop the body of the server-reference map from a chunk's source.
 *
 * The map lists every `"use server"` module of the build with its export
 * names, and it sits in a chunk every router runs (plugin-rsc's server
 * runtime imports it). Hashed as is, the map would put every app's action
 * list into every app's version. Its text is derived: each module it names is
 * hashed by the routers that reach it (resolveRouterMembers), so nothing the
 * map says is lost by skipping it.
 *
 * Works on the region comments, so a minified server build (which has none)
 * keeps the map in every router's hash: more clearing, never less.
 */
export function stripServerReferenceMap(source: string): string {
  const start = source.indexOf(SERVER_REFERENCES_REGION_START);
  if (start === -1) return source;
  const bodyStart = start + SERVER_REFERENCES_REGION_START.length;
  const end = source.indexOf(REGION_END, bodyStart);
  if (end === -1) return source;
  return source.slice(0, bodyStart) + source.slice(end);
}

const REGION_LINE = /^\/\/#region .*$/gm;

/**
 * Take the module paths out of a chunk's region comments.
 *
 * The bundler prints one before each module's code, and the path says where
 * the build ran, not what it built: it is relative to the directory `vite
 * build` was started from (`vite build apps/web` from a repository root
 * prints other paths than `vite build` in the app), it holds the pnpm store
 * directory with its peer suffix, and a virtual id is printed verbatim,
 * absolute paths in its query included. The code under the comment is hashed
 * either way.
 */
export function stripRegionPaths(source: string): string {
  return source.replace(REGION_LINE, "//#region");
}

/** One thing a version is a hash of: its name and the digest of its bytes. */
export type VersionInput = readonly [name: string, digest: string];

/** One bundle file, digested once for every router. */
export interface DigestedFile {
  readonly fileName: string;
  /**
   * What the file is, independent of its content: the un-hashed name plus, for
   * a chunk, a digest of the module ids inside it. Stands in for the file's
   * hashed name wherever a router that owns the file refers to it.
   */
  readonly identity: string;
  /**
   * Digest of the file's bytes with every reference to a bundle file replaced
   * by one token ({@link FILE_REFERENCE}), so a content hash in a file name
   * never reaches it.
   */
  readonly base: string;
  /** The files those references named, in order of appearance. */
  readonly references: readonly string[];
  /** Specifiers the file imports that the bundle does not contain. */
  readonly externalImports: readonly string[];
}

/**
 * Stands for a file name in the text a chunk's `base` is a digest of. A NUL:
 * no chunk has one in its text, so a reference cannot be confused with code
 * around it (a `~` operator, say).
 */
const FILE_REFERENCE = "\0";
/** Stands for a reference to a file outside the router's set. */
const FOREIGN_FILE = "~";

/**
 * Digest every file of a bundle, as it is on disk.
 *
 * Three things are taken out of a chunk's text first, each because it says
 * where or how the build ran: the server-reference map's body
 * ({@link stripServerReferenceMap}), the paths in region comments
 * ({@link stripRegionPaths}), and the hashed names of bundle files. A name
 * carries the content hash of its file, and every chunk importing the file
 * has the name in its bytes, so one router's change would otherwise move the
 * digest of every chunk naming its chunk. Only names with a content hash are
 * replaced; a fixed name such as the entry's "index.js" is the same in every
 * build. An asset is data (a route manifest staged as a text module can be
 * megabytes): hashed as bytes, never scanned.
 *
 * Throws when the bundle lists a file that is not on disk: its bytes would
 * silently drop out of every version.
 */
export function digestBundle(
  bundle: BundleFiles,
  projectRoot: string,
  read: (fileName: string) => Uint8Array | undefined,
  label: string,
): DigestedFile[] {
  const named: Array<{
    fileName: string;
    identity: string;
    hashedName: boolean;
    chunk?: BuildChunk;
  }> = [];
  for (const chunk of bundle.chunks) {
    const ids = chunk.moduleIds
      .map((id) => portableModuleId(id, projectRoot))
      .sort();
    const ext = posix.extname(chunk.fileName);
    named.push({
      fileName: chunk.fileName,
      identity: `${chunk.name}~${sha256(ids.join("\n")).slice(0, 8)}${ext}`,
      hashedName: baseName(chunk.fileName) !== chunk.name + ext,
      chunk,
    });
  }
  for (const asset of bundle.assets) {
    if (isSourceMap(asset.fileName)) continue;
    named.push({
      fileName: asset.fileName,
      identity: asset.name,
      hashedName: baseName(asset.fileName) !== baseName(asset.name),
    });
  }

  const fileOfBaseName = new Map<string, string>();
  for (const file of named) {
    if (file.hashedName) {
      fileOfBaseName.set(baseName(file.fileName), file.fileName);
    }
  }
  const reference =
    fileOfBaseName.size > 0
      ? new RegExp(
          [...fileOfBaseName.keys()]
            .sort((a, b) => b.length - a.length)
            .map(escapeRegExp)
            .join("|"),
          "g",
        )
      : undefined;

  const decoder = new TextDecoder();
  return named.map(({ fileName, identity, chunk }) => {
    const bytes = read(fileName);
    if (bytes === undefined) {
      throw new Error(
        `the ${label} bundle lists ${fileName}, which is not in its output directory`,
      );
    }
    if (!chunk) {
      return {
        fileName,
        identity,
        base: sha256(bytes),
        references: [],
        externalImports: [],
      };
    }
    const references: string[] = [];
    const text = stripRegionPaths(
      stripServerReferenceMap(decoder.decode(bytes)),
    );
    const blanked = reference
      ? text.replace(reference, (name) => {
          references.push(fileOfBaseName.get(name)!);
          return FILE_REFERENCE;
        })
      : text;
    return {
      fileName,
      identity,
      base: sha256(blanked),
      references,
      externalImports: chunk.externalImports ?? [],
    };
  });
}

/**
 * A file's digest as the owner of `owned` sees it: each reference becomes the
 * target's identity when the owner has the target, one fixed token when it
 * does not. A change to a chunk a router does not own cannot reach its hash
 * through a file name.
 */
function digestAsOwned(
  file: DigestedFile,
  identityOf: ReadonlyMap<string, string>,
  owned: ReadonlySet<string>,
): string {
  if (file.references.length === 0) return file.base;
  return sha256(
    JSON.stringify([
      file.base,
      ...file.references.map((name) =>
        owned.has(name) ? identityOf.get(name)! : FOREIGN_FILE,
      ),
    ]),
  );
}

/** How the build reads what the bundles leave external. */
export interface ExternalResolver {
  /**
   * What is installed for a package: `name@version` of the package and of
   * everything it depends on (installed-packages.ts). The chunk only says
   * `from "pkg"`, whichever version that is. `undefined` when the package
   * cannot be found.
   */
  readonly describePackage: (name: string) => string | undefined;
  /** The bytes of a file at an absolute path; `undefined` when it is absent. */
  readonly readFile: (path: string) => Uint8Array | undefined;
  /** Unique to this build: the digest of an input that cannot be determined. */
  readonly buildId: string;
}

export type ExternalImport =
  | { readonly kind: "provided" }
  | { readonly kind: "package"; readonly name: string }
  | { readonly kind: "file" }
  | { readonly kind: "unknown" };

/** What the runtime itself provides: nothing a build could install or change. */
const RUNTIME_SCHEME = /^(?:node|cloudflare|workerd|bun):/;
/**
 * Specifiers another plugin replaces when it renders the chunk, for a file
 * the versions already cover:
 *
 * - @cloudflare/vite-plugin imports a text, data or wasm module as
 *   `__CLOUDFLARE_MODULE__<type>__<path>__CLOUDFLARE_MODULE__`; the file it
 *   emits is a bundle asset the chunk names, hashed as one
 *   ({@link digestBundle}).
 * - plugin-rsc resolves `virtual:vite-rsc/assets-manifest` as external and
 *   writes the manifest after every bundle. A data version covers what a
 *   router's server code renders from it, entry by entry (`server-css`
 *   records); the document version covers the client asset names.
 */
const REPLACED_MARKER =
  /^(?:__CLOUDFLARE_MODULE__.*__CLOUDFLARE_MODULE__|virtual:vite-rsc\/assets-manifest)$/;
/** A name npm accepts: no leading `.` or `_`. */
const PACKAGE_NAME = /^(?:@[\w.~-]+\/)?[A-Za-z0-9~-][\w.~-]*$/;

/**
 * What an import a bundle leaves external is. THE rule for all of them, and
 * the only place it is decided:
 *
 * - `provided`: the version does not cover it. A runtime builtin (`node:fs`,
 *   bare `fs`, `cloudflare:workers`, `bun:sqlite`), a `data:` URL (its content
 *   is the specifier, which is in the chunk), or a marker of another plugin
 *   whose file is a bundle output the hash already covers.
 * - `package`: an installed package. The version covers what is installed.
 * - `file`: a relative or absolute path. The version covers the file's bytes.
 * - `unknown`: anything else (`https:`, `npm:`, a name npm would reject).
 *
 * A package that is not installed, a path that does not resolve and every
 * `unknown` import get a value unique to the build, and the build names them:
 * the routers importing them get a new version on every build. Nothing the
 * build cannot read is left out of a version.
 */
export function classifyExternal(specifier: string): ExternalImport {
  if (/^[./\\]/.test(specifier) || isAbsolutePath(specifier)) {
    return { kind: "file" };
  }
  if (
    RUNTIME_SCHEME.test(specifier) ||
    specifier.startsWith("data:") ||
    isBuiltin(specifier) ||
    REPLACED_MARKER.test(specifier)
  ) {
    return { kind: "provided" };
  }
  if (specifier.includes(":")) return { kind: "unknown" };
  const parts = specifier.split("/");
  const name = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0]!;
  return PACKAGE_NAME.test(name)
    ? { kind: "package", name }
    : { kind: "unknown" };
}

interface ExternalContext {
  readonly projectRoot: string;
  readonly externals: ExternalResolver;
  /** Read a file of the output directory the importing chunk is in. */
  readonly read: (fileName: string) => Uint8Array | undefined;
  /** Imports the build could not determine, as the build names them. */
  readonly undetermined: Set<string>;
}

/** The version inputs for what one chunk leaves external ({@link classifyExternal}). */
function externalInputs(
  file: DigestedFile,
  context: ExternalContext,
): VersionInput[] {
  const { externals, undetermined } = context;
  const inputs: VersionInput[] = [];
  const add = (name: string, value: string | Uint8Array | undefined): void => {
    if (value === undefined) undetermined.add(name);
    inputs.push([
      `external ${name}`,
      sha256(value ?? `undetermined ${externals.buildId}`),
    ]);
  };
  for (const specifier of file.externalImports) {
    const external = classifyExternal(specifier);
    if (external.kind === "package") {
      add(external.name, externals.describePackage(external.name));
    } else if (external.kind === "file") {
      if (isAbsolutePath(specifier)) {
        // Named root-relative inside the project. Outside it the path is the
        // same on every checkout, and a relative one would count the
        // directories between.
        const inProject = portableModuleId(specifier, context.projectRoot);
        add(
          inProject.startsWith("..") ? specifier : inProject,
          externals.readFile(specifier),
        );
      } else {
        // As written in the chunk: relative to the chunk's own directory.
        const fileName = posix.join(
          posix.dirname(file.fileName),
          specifier.replaceAll("\\", "/"),
        );
        add(fileName, context.read(fileName));
      }
    } else if (external.kind === "unknown") {
      add(specifier, undefined);
    }
  }
  return inputs;
}

export interface ComputeRouterVersionsInput {
  readonly projectRoot: string;
  readonly server: ServerBuildGraph;
  readonly client: ClientBuildGraph;
  /** The SSR environment's bundle, with the files plugin-rsc writes next to it. */
  readonly ssr: BundleFiles;
  readonly routers: readonly RouterSource[];
  readonly buildData: readonly BuildDataRecord[];
  /** Read a file of the RSC output directory; undefined when it is absent. */
  readonly readServerFile: (fileName: string) => Uint8Array | undefined;
  /** Read a file of the SSR output directory; undefined when it is absent. */
  readonly readSsrFile: (fileName: string) => Uint8Array | undefined;
  /** Vite's `base`, a prefix of every asset URL in stored HTML. */
  readonly base: string;
  /**
   * plugin-rsc's `serverResources` from the built assets manifest: the
   * root-relative id of a server module that imports CSS, to the text of its
   * entry (the stylesheet URLs).
   */
  readonly serverResources?: ReadonlyMap<string, string>;
  readonly externals: ExternalResolver;
}

export interface RouterVersionDetail {
  readonly routerId: string;
  readonly data: string;
  readonly document: string;
  /**
   * Everything the data version is a hash of, in hashed order: `file
   * <identity>` for a server file, `static <id>` for a Static payload,
   * `client-urls <module>` for a clientUrls() projection, `server-css
   * <module>` for a server component's stylesheets, `external <import>` for
   * what the bundle left external, `encryption-key` for the key. Two builds'
   * lists differ exactly where the version's inputs differ.
   */
  readonly dataInputs: readonly VersionInput[];
  /**
   * What the document version adds to the data version: `ssr-and-client` (the
   * SSR output and the client asset names) and `prerender <key>` for a
   * Prerender payload.
   */
  readonly documentInputs: readonly VersionInput[];
  /** The key is part of the router's data version. */
  readonly usesEncryptionKey: boolean;
}

/**
 * What stored HTML depends on besides a router's server code, one set for the
 * build (the SSR output is not split by router). Hashed as the
 * `ssr-and-client` input of every document version.
 */
export interface SsrAndClientInputs {
  /** Vite's `base`, a prefix of every asset URL in stored HTML. */
  readonly base: string;
  /**
   * The SSR output, file by file ({@link digestBundle}). It renders the HTML,
   * and its own code can change without the client's.
   */
  readonly ssr: readonly VersionInput[];
  /** What the SSR output leaves external ({@link classifyExternal}). */
  readonly externals: readonly VersionInput[];
  /**
   * The client asset names. A prelude and an open tab both hold them, and the
   * names carry the bundler's content hashes.
   */
  readonly client: readonly string[];
}

export interface ComputedRouterVersions {
  readonly table: RouterVersionsTable;
  /** One entry per attributed router, then the whole-build entry. */
  readonly details: readonly RouterVersionDetail[];
  /** What every document version covers besides its router's data version. */
  readonly ssrAndClient: SsrAndClientInputs;
  /** Server files no attributed router owns, by identity. */
  readonly unownedFiles: readonly string[];
  /** Imports the build could not determine ({@link classifyExternal}). */
  readonly undetermined: readonly string[];
}

/** Length of a version string: 64 bits of the digest, in hex. */
const VERSION_HEX_LENGTH = 16;

/** By name, then digest: a total order, whatever order the bundle listed. */
function byName(a: VersionInput, b: VersionInput): number {
  return compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]);
}

/** `inputs` in hashed order, each one once (two chunks can import one package). */
function distinct(inputs: readonly VersionInput[]): VersionInput[] {
  const sorted = [...inputs].sort(byName);
  return sorted.filter(
    (item, index) => index === 0 || byName(item, sorted[index - 1]!) !== 0,
  );
}

function hashInputs(label: string, inputs: readonly VersionInput[]): string {
  // JSON keeps names and digests apart whatever characters a name holds (a
  // prerender key is a URL path).
  return sha256(`${label}\n${JSON.stringify(inputs)}`).slice(
    0,
    VERSION_HEX_LENGTH,
  );
}

/** A version input that is not a file: owned by {@link ownersOf}. */
interface OwnedInput {
  readonly input: VersionInput;
  readonly version: "data" | "document";
  /** Owning routers; `undefined`: every router. */
  readonly owners: ReadonlySet<string> | undefined;
}

/**
 * The records for a build's `serverResources`. The links of an entry are
 * rendered by plugin-rsc's CSS module for it
 * (`virtual:vite-rsc/css?type=rsc&id=<module the entry is keyed by>`), which
 * is what a router has to reach. With an explicit
 * `import.meta.viteRsc.loadCss("./other")` that is not the keyed module.
 */
function serverCssRecords(
  server: ServerBuildGraph,
  projectRoot: string,
  serverResources: ReadonlyMap<string, string>,
): BuildDataRecord[] {
  if (serverResources.size === 0) return [];
  const moduleOf = new Map<string, string>();
  for (const id of server.modules.keys()) {
    const key = portableModuleId(id, projectRoot).match(SERVER_CSS_MODULE)?.[1];
    if (key !== undefined) moduleOf.set(key, id);
  }
  return [...serverResources].map(([key, entry]) => ({
    kind: "server-css",
    key,
    digest: sha256(entry),
    moduleId: moduleOf.get(key),
  }));
}

/**
 * Compute every router's data and document version, and the whole-build pair.
 *
 * A router's data version covers: its chunk files, the bundle assets those
 * files name (a route manifest staged as a text module), what those files
 * leave external, and the inputs it owns that no chunk holds
 * ({@link ownersOf}). Its document version is the data version plus the SSR
 * output, the client asset names, `base` and its Prerender payloads.
 */
export function computeRouterVersions(
  input: ComputeRouterVersionsInput,
): ComputedRouterVersions {
  const { server, projectRoot } = input;
  const undetermined = new Set<string>();

  const files = digestBundle(server, projectRoot, input.readServerFile, "RSC");
  const identityOf = new Map(
    files.map((file) => [file.fileName, file.identity]),
  );
  const assetFiles = new Set(server.assets.map((asset) => asset.fileName));
  const externalContext: ExternalContext = {
    projectRoot,
    externals: input.externals,
    read: input.readServerFile,
    undetermined,
  };
  const externalsOf = new Map(
    files.map((file) => [file.fileName, externalInputs(file, externalContext)]),
  );

  const members = resolveRouterMembers(server, input.client, input.routers);
  const reachOf = new Map(
    [...members].map(([routerId, member]) => [routerId, member.modules]),
  );

  const owned = [
    ...input.buildData,
    ...serverCssRecords(
      server,
      projectRoot,
      input.serverResources ?? new Map(),
    ),
  ].map(
    (record): OwnedInput => ({
      input: [`${record.kind} ${record.key}`, record.digest],
      version: record.kind === "prerender" ? "document" : "data",
      owners:
        record.routerId !== undefined
          ? new Set([record.routerId])
          : ownersOf(
              record.moduleId === undefined ? [] : [record.moduleId],
              reachOf,
            ),
    }),
  );

  // The key belongs to the routers whose code encrypts with it. A key file
  // with no module recognised as encrypting means the recognition failed
  // (the file is written only when a chunk reads the key): every router's.
  const encrypting = [...server.modules]
    .filter(([, edges]) => edges.encryptsBoundArgs)
    .map(([id]) => id);
  const keyFile = input.readServerFile(ENCRYPTION_KEY_FILE);
  if (keyFile !== undefined) {
    owned.push({
      input: ["encryption-key", sha256(keyFile)],
      version: "data",
      owners: ownersOf(encrypting, reachOf),
    });
  } else if (encrypting.length > 0) {
    throw new Error(
      `${encrypting.length} server module(s) encrypt action arguments ` +
        `(${portableModuleId(encrypting[0]!, projectRoot)}), but ${ENCRYPTION_KEY_FILE} is not in the RSC ` +
        `output directory, so the key cannot be made part of their cache version. The installed ` +
        `@vitejs/plugin-rsc keeps the key somewhere @rangojs/router does not know. Report it ` +
        `with the plugin-rsc version.`,
    );
  }
  const keyInput = owned.find((item) => item.input[0] === "encryption-key");

  // What stored HTML depends on besides a router's server code. One digest
  // for the build: the SSR output is not split by router.
  const ssrFiles = digestBundle(
    input.ssr,
    projectRoot,
    input.readSsrFile,
    "SSR",
  );
  const ssrIdentityOf = new Map(
    ssrFiles.map((file) => [file.fileName, file.identity]),
  );
  const everySsrFile = new Set(ssrFiles.map((file) => file.fileName));
  const ssrAndClient: SsrAndClientInputs = {
    base: input.base,
    ssr: distinct(
      ssrFiles.map((file) => [
        file.identity,
        digestAsOwned(file, ssrIdentityOf, everySsrFile),
      ]),
    ),
    externals: distinct(
      ssrFiles.flatMap((file) =>
        externalInputs(file, { ...externalContext, read: input.readSsrFile }),
      ),
    ),
    client: [...input.client.fileNames].sort(),
  };
  const documentDigest = sha256(JSON.stringify(ssrAndClient));

  const table: Record<string, readonly [string, string]> = {};
  const details: RouterVersionDetail[] = [];
  const ownedByARouter = new Set<string>();
  /** `chunkFiles`: the router's, or `undefined` for the whole build. */
  const add = (routerId: string, chunkFiles?: ReadonlySet<string>): void => {
    const whole = chunkFiles === undefined;
    const ownedFiles = new Set(
      chunkFiles ?? files.map((file) => file.fileName),
    );
    for (const file of files) {
      if (!ownedFiles.has(file.fileName)) continue;
      for (const name of file.references) {
        if (assetFiles.has(name)) ownedFiles.add(name);
      }
    }

    const inputs: Record<"data" | "document", VersionInput[]> = {
      data: [],
      document: [["ssr-and-client", documentDigest]],
    };
    for (const file of files) {
      if (!ownedFiles.has(file.fileName)) continue;
      if (!whole) ownedByARouter.add(file.fileName);
      inputs.data.push(
        [`file ${file.identity}`, digestAsOwned(file, identityOf, ownedFiles)],
        ...externalsOf.get(file.fileName)!,
      );
    }
    for (const item of owned) {
      if (whole || item.owners === undefined || item.owners.has(routerId)) {
        inputs[item.version].push(item.input);
      }
    }
    const dataInputs = distinct(inputs.data);
    const documentInputs = distinct(inputs.document);

    const data = hashInputs("rango-data-version", dataInputs);
    const document = hashInputs(
      `rango-document-version\n${data}`,
      documentInputs,
    );
    table[routerId] = [data, document];
    details.push({
      routerId,
      data,
      document,
      dataInputs,
      documentInputs,
      usesEncryptionKey:
        keyInput !== undefined &&
        (whole ||
          keyInput.owners === undefined ||
          keyInput.owners.has(routerId)),
    });
  };

  for (const router of input.routers) {
    const member = members.get(router.id);
    if (member) add(router.id, member.chunkFiles);
  }
  add(DEFAULT_ROUTER_VERSIONS_KEY);
  return {
    table,
    details,
    ssrAndClient,
    unownedFiles: files
      .filter((file) => !ownedByARouter.has(file.fileName))
      .map((file) => file.identity)
      .sort(),
    undetermined: [...undetermined].sort(),
  };
}

/**
 * The chunk files of a bundle that hold the `@rangojs/router:version` module,
 * where the placeholder has to be replaced. Recorded for every environment:
 * the module is emitted wherever something imports it (a second worker that
 * uses a cache store), and an unreplaced placeholder throws on load.
 */
export function recordVersionModuleFiles(bundle: OutputBundleLike): string[] {
  return Object.values(bundle)
    .filter(
      (file) =>
        file.type === "chunk" && file.moduleIds?.includes(VERSION_MODULE),
    )
    .map((file) => file.fileName);
}

/**
 * Replace the version module's placeholder with the table. Returns undefined
 * when `source` does not hold the placeholder.
 */
export function fillRouterVersions(
  source: string,
  table: RouterVersionsTable,
): string | undefined {
  if (!source.includes(ROUTER_VERSIONS_PLACEHOLDER)) return undefined;
  // A replacer function: a consumer's router id may hold `$`, which a string
  // replacement would read as a pattern (`$$`, `$'`).
  const json = JSON.stringify(table);
  return source.replaceAll(ROUTER_VERSIONS_PLACEHOLDER, () => json);
}
