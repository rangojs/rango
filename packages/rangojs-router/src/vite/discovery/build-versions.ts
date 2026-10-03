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
 *    chunk file names replaced by content-independent tokens. Without that
 *    replacement a file name's content hash carries one router's change into
 *    every chunk that names it.
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

/** The RSC environment's bundle, from its real (not scan) build pass. */
export interface ServerBuildGraph {
  readonly modules: ReadonlyMap<string, BuildModuleEdges>;
  readonly chunks: readonly BuildChunk[];
  readonly assets: readonly BuildAsset[];
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
 * - A Prerender payload is served from the build's own store and never
 *   written to the segment cache (withCacheLookup returns before the cache
 *   scope, match-middleware/cache-lookup.ts). Only stored HTML holds it: a PPR
 *   shell or a document-cache response of the route. It is part of the
 *   DOCUMENT version only.
 */
export interface BuildDataRecord {
  readonly kind: "prerender" | "static" | "client-urls";
  /** Prerender manifest key, Static handler id, or clientUrls() module. */
  readonly key: string;
  /** sha256 of the payload, or of the projection. */
  readonly digest: string;
  /** Router that rendered it (prerender). */
  readonly routerId?: string;
  /**
   * Module the data belongs to (static: the handler's; client-urls: the
   * clientUrls() module). The routers that reach it own the record; one no
   * router reaches is every router's.
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

/**
 * plugin-rsc imports its encryption runtime into every `"use server"` module
 * it transforms and calls this function only where an inline action closes
 * over a value (its `encode` hook). Importing the runtime is therefore not a
 * sign that a module encrypts; the call is.
 */
const ENCRYPTION_RUNTIME_ID = "/utils/encryption-runtime";
const ENCRYPT_CALL = "encryptActionBoundArgs(";

function recordModuleEdges(
  context: ModuleGraphContext,
): Map<string, BuildModuleEdges> {
  const modules = new Map<string, BuildModuleEdges>();
  for (const id of context.getModuleIds()) {
    const info = context.getModuleInfo(id);
    const imports = info?.importedIds ?? [];
    // `code` is read only for the few modules that import the runtime. One
    // whose code the bundler does not hand out is counted as encrypting.
    const encryptsBoundArgs =
      imports.some((imported) => imported.includes(ENCRYPTION_RUNTIME_ID)) &&
      (info?.code == null || info.code.includes(ENCRYPT_CALL));
    modules.set(id, {
      imports,
      dynamicImports: info?.dynamicallyImportedIds ?? [],
      ...(encryptsBoundArgs ? { encryptsBoundArgs } : undefined),
    });
  }
  return modules;
}

/** Every file a bundle emits, chunks and assets. */
export function recordBundleFileNames(bundle: OutputBundleLike): string[] {
  return Object.values(bundle).map((file) => file.fileName);
}

/** What the chunks of a bundle import from outside it, as written. */
export function recordExternalImports(bundle: OutputBundleLike): string[] {
  const external = new Set<string>();
  for (const file of Object.values(bundle)) {
    for (const specifier of externalImportsOf(file, bundle)) {
      external.add(specifier);
    }
  }
  return [...external];
}

function externalImportsOf(
  file: OutputBundleLike[string],
  bundle: OutputBundleLike,
): string[] {
  return [...(file.imports ?? []), ...(file.dynamicImports ?? [])].filter(
    (specifier) => !Object.hasOwn(bundle, specifier),
  );
}

/** Call from the RSC environment's generateBundle. */
export function recordServerGraph(
  context: ModuleGraphContext,
  bundle: OutputBundleLike,
): ServerBuildGraph {
  const chunks: BuildChunk[] = [];
  const assets: BuildAsset[] = [];
  for (const file of Object.values(bundle)) {
    if (file.type === "chunk") {
      chunks.push({
        fileName: file.fileName,
        name: file.name ?? file.fileName,
        moduleIds: file.moduleIds ?? [],
        externalImports: externalImportsOf(file, bundle),
      });
    } else {
      assets.push({
        fileName: file.fileName,
        name: file.names?.[0] ?? file.fileName,
      });
    }
  }
  return { modules: recordModuleEdges(context), chunks, assets };
}

/** Call from the client environment's generateBundle. */
export function recordClientGraph(
  context: ModuleGraphContext,
  bundle: OutputBundleLike,
): ClientBuildGraph {
  return {
    modules: recordModuleEdges(context),
    fileNames: recordBundleFileNames(bundle),
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
 * in no chunk and in no bundle graph.
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

/** What one router's walk has covered so far, in each graph. */
interface Reach {
  readonly server: Set<string>;
  readonly client: Set<string>;
  /** Server modules already used as roots of the client walk. */
  readonly seeded: Set<string>;
}

/**
 * Add everything `roots` can run to `reach.server`.
 *
 * A `"use client"` module is a leaf in the server graph (plugin-rsc replaces it
 * with reference proxies), so a server action or loader that only client code
 * imports is not reachable from the router's module there. It is reachable in
 * the CLIENT graph, where the same file imports it as a proxy. So: take every
 * reached module that also exists in the client graph, walk the client graph
 * from it, and add the registry targets found. Repeat until nothing is added,
 * since an action's own imports can render more client components.
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
      if (!reach.seeded.has(id) && client.modules.has(id)) {
        reach.seeded.add(id);
        seeds.push(id);
      }
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
  const roots = new Map<string, Set<string>>();
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
    roots.set(router.id, climbed);
  }

  const reachByRouter = new Map<string, Reach>();
  for (const [routerId, routerRoots] of roots) {
    const reach: Reach = {
      server: new Set(),
      client: new Set(),
      seeded: new Set(),
    };
    extendReach(server, client, targets, reach, routerRoots);
    reachByRouter.set(routerId, reach);
  }

  // A registry target no router reaches (an action only the browser entry
  // imports, a loader nothing imports) can still be called through any router's
  // action or loader endpoint. It belongs to every router.
  const unattributed: string[] = [];
  for (const target of targets) {
    let claimed = false;
    for (const reach of reachByRouter.values()) {
      if (reach.server.has(target)) {
        claimed = true;
        break;
      }
    }
    if (!claimed) unattributed.push(target);
  }
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
 * A module id without the build machine's checkout directory: root-relative
 * inside the project, and from the outermost node_modules for an installed
 * package. The outermost, not the innermost: two installed versions of one
 * package differ only in the directories between (`.pnpm/foo@1…/node_modules/foo`,
 * a nested `a/node_modules/foo`), and must not get the same id.
 *
 * A virtual id can carry a file path in its query. plugin-rsc's server CSS
 * module is `virtual:vite-rsc/css?type=rsc&id=<URI-encoded absolute importer>`,
 * so those values are made portable too.
 */
export function portableModuleId(id: string, projectRoot: string): string {
  const path = id.startsWith("\0") ? id.slice(1) : id;
  const nodeModules = path.indexOf("/node_modules/");
  if (nodeModules !== -1) return path.slice(nodeModules + 1);
  if (isAbsolutePath(path)) {
    return relative(projectRoot, path).replaceAll("\\", "/");
  }
  return path.replace(/([?&][^=&]+=)([^&]+)/g, (whole, name, value) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return whole;
    }
    return isAbsolutePath(decoded)
      ? name + portableModuleId(decoded, projectRoot)
      : whole;
  });
}

/**
 * The bundler's region comment for a virtual module, as printed in an
 * unminified chunk (`\0` is two characters there). It prints a virtual id
 * verbatim, so an absolute path in the id's query puts the checkout directory
 * in the chunk; a file module's region is already root-relative.
 */
const VIRTUAL_REGION = /^\/\/#region \\0(.*)$/gm;
/** plugin-rsc's server CSS module, as a portable id; captures the importer. */
const SERVER_CSS_MODULE = /^virtual:vite-rsc\/css\?type=rsc&id=([^&]+)/;
const VIRTUAL_REGION_MARK = "//#region \\0";

/** `source` with the ids in its virtual-module region comments made portable. */
export function portableRegions(source: string, projectRoot: string): string {
  if (!source.includes(VIRTUAL_REGION_MARK)) return source;
  return source.replace(
    VIRTUAL_REGION,
    (_line, id: string) =>
      VIRTUAL_REGION_MARK + portableModuleId(id, projectRoot),
  );
}

interface ServerFile {
  readonly fileName: string;
  /**
   * What the file is, independent of its content: the un-hashed name plus, for
   * a chunk, a digest of the module ids inside it. Replaces the file's hashed
   * name wherever a router that owns the file refers to it.
   */
  readonly identity: string;
  /**
   * The file name carries a content hash. Only those names are replaced; a
   * fixed name such as the entry's "index.js" is the same in every build.
   */
  readonly hashedName: boolean;
  /** The chunk holds plugin-rsc's server-reference map. */
  readonly holdsServerReferences: boolean;
}

function describeServerFiles(
  server: ServerBuildGraph,
  projectRoot: string,
): ServerFile[] {
  const files: ServerFile[] = [];
  for (const chunk of server.chunks) {
    const ids = chunk.moduleIds
      .map((id) => portableModuleId(id, projectRoot))
      .sort();
    const ext = posix.extname(chunk.fileName);
    files.push({
      fileName: chunk.fileName,
      identity: `${chunk.name}~${sha256(ids.join("\n")).slice(0, 8)}${ext}`,
      hashedName: baseName(chunk.fileName) !== chunk.name + ext,
      holdsServerReferences: chunk.moduleIds.includes(
        SERVER_REFERENCES_MODULE_ID,
      ),
    });
  }
  for (const asset of server.assets) {
    if (isSourceMap(asset.fileName)) continue;
    files.push({
      fileName: asset.fileName,
      identity: asset.name,
      hashedName: baseName(asset.fileName) !== baseName(asset.name),
      holdsServerReferences: false,
    });
  }
  return files;
}

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

/** A file's text, split at every reference to another bundle file. */
interface FileTemplate {
  readonly parts: ReadonlyArray<string | ServerFile>;
  /** The distinct files `parts` refers to. */
  readonly targets: readonly ServerFile[];
  /** Digest per ownership of `targets`: routers that own the same ones share it. */
  readonly digests: Map<string, string>;
}

/** Token for a reference to a file outside the router's set. */
const FOREIGN_FILE = "~";

/**
 * Digest one file as one router sees it.
 *
 * Each reference to a bundle file is replaced before hashing: by the target's
 * identity when the router owns it, by one fixed token when it does not. So a
 * change to a chunk the router does not own cannot reach its hash through a
 * file name, and neither can the content hashes the bundler put in the names.
 */
function digestFile(
  template: FileTemplate,
  owned: ReadonlySet<string>,
): string {
  let ownership = "";
  for (const target of template.targets) {
    ownership += owned.has(target.fileName) ? "1" : "0";
  }
  let digest = template.digests.get(ownership);
  if (digest === undefined) {
    const hash = createHash("sha256");
    for (const part of template.parts) {
      hash.update(
        typeof part === "string"
          ? part
          : owned.has(part.fileName)
            ? part.identity
            : FOREIGN_FILE,
      );
    }
    digest = hash.digest("hex");
    template.digests.set(ownership, digest);
  }
  return digest;
}

export interface ComputeRouterVersionsInput {
  readonly projectRoot: string;
  readonly server: ServerBuildGraph;
  readonly client: ClientBuildGraph | undefined;
  readonly routers: readonly RouterSource[];
  readonly buildData: readonly BuildDataRecord[];
  /** Read a file of the RSC output directory; undefined when it is absent. */
  readonly readServerFile: (fileName: string) => Uint8Array | undefined;
  /**
   * Digest of what stored HTML depends on besides the router's server code:
   * the SSR output and the client asset names ({@link digestDocumentInputs}).
   */
  readonly documentDigest: string;
  /**
   * plugin-rsc's `serverResources` from the built assets manifest: the
   * root-relative id of a server module that imports CSS, to the text of its
   * entry (the stylesheet URLs). The module's wrapper reads that entry at run
   * time and renders the URLs as `<link>`s into the router's Flight, so they
   * are in cached payloads while no server chunk holds them.
   */
  readonly serverResources?: ReadonlyMap<string, string>;
  /**
   * What is installed for a package the bundle leaves external: `name@version`
   * of the package and of everything it depends on. The chunk only says
   * `from "pkg"`, whichever version that is. `undefined` when the package
   * cannot be found.
   */
  readonly describeExternal?: (packageName: string) => string | undefined;
}

/** A name npm accepts: no leading `.` or `_`. */
const PACKAGE_NAME = /^(?:@[\w.~-]+\/)?[A-Za-z0-9~-][\w.~-]*$/;

/**
 * The package a specifier the bundle left external names, or `undefined` for
 * what is not an installed package: a path, a builtin, a platform scheme
 * (`node:`, `cloudflare:`), or a marker another plugin replaces when it
 * renders the chunk. @cloudflare/vite-plugin imports a text or wasm module as
 * `__CLOUDFLARE_MODULE__<type>__<path>__CLOUDFLARE_MODULE__` and emits its
 * content as a bundle asset, which is hashed as a file.
 */
export function externalPackage(specifier: string): string | undefined {
  if (/^[./\\]/.test(specifier) || specifier.includes(":")) return undefined;
  if (isBuiltin(specifier)) return undefined;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0]!;
  return PACKAGE_NAME.test(name) ? name : undefined;
}

/** One thing a version is a hash of: its name and the digest of its bytes. */
export type VersionInput = readonly [name: string, digest: string];

export interface RouterVersionDetail {
  readonly routerId: string;
  readonly data: string;
  readonly document: string;
  /**
   * Everything the data version is a hash of, in hashed order: `file
   * <identity>` for a server file, `static <id>` for a Static payload,
   * `server-css <module>` for a server component's stylesheets, `external
   * <package>` for an installed dependency the bundle left external,
   * `encryption-key` for the key. Two builds' lists differ exactly where the
   * version's inputs differ.
   */
  readonly dataInputs: readonly VersionInput[];
  /**
   * What the document version adds to the data version: `ssr-and-client` (the
   * SSR output and the client asset names) and `prerender <key>` for a
   * Prerender payload.
   */
  readonly documentInputs: readonly VersionInput[];
  /** The router's code encrypts inline-action bound arguments. */
  readonly usesEncryptionKey: boolean;
}

export interface ComputedRouterVersions {
  readonly table: RouterVersionsTable;
  /** One entry per attributed router, then the whole-build entry. */
  readonly details: readonly RouterVersionDetail[];
}

/** Length of a version string: 64 bits of the digest, in hex. */
const VERSION_HEX_LENGTH = 16;

/** By name, then digest: a total order, whatever order the bundle listed. */
function byName(a: VersionInput, b: VersionInput): number {
  return compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]);
}

function hashInputs(label: string, inputs: readonly VersionInput[]): string {
  // JSON keeps names and digests apart whatever characters a name holds (a
  // prerender key is a URL path).
  return sha256(`${label}\n${JSON.stringify(inputs)}`).slice(
    0,
    VERSION_HEX_LENGTH,
  );
}

/**
 * Compute every router's data and document version, and the whole-build pair.
 *
 * A router's data version covers: its chunk files, the bundle assets those
 * files name (a route manifest staged as a text module), the build-rendered
 * payloads it owns, and the encryption key when its code encrypts with it.
 * Its document version is the data version plus `documentDigest`.
 */
export function computeRouterVersions(
  input: ComputeRouterVersionsInput,
): ComputedRouterVersions {
  const { server, projectRoot } = input;
  const files = describeServerFiles(server, projectRoot);

  const identityByBaseName = new Map<string, ServerFile>();
  for (const file of files) {
    if (file.hashedName) identityByBaseName.set(baseName(file.fileName), file);
  }
  const reference =
    identityByBaseName.size > 0
      ? new RegExp(
          [...identityByBaseName.keys()]
            .sort((a, b) => b.length - a.length)
            .map(escapeRegExp)
            .join("|"),
          "g",
        )
      : undefined;

  // What to hash per file. A digest that no router's view can change (an
  // asset, a chunk that names no other file) is computed once; a chunk with
  // references is hashed once per distinct ownership of them (digestFile).
  const hashable = new Map<string, string | FileTemplate>();
  const assetsNamedBy = new Map<string, string[]>();
  const assetFiles = new Set(server.assets.map((asset) => asset.fileName));
  const decoder = new TextDecoder();
  for (const file of files) {
    const onDisk = input.readServerFile(file.fileName);
    if (onDisk === undefined) continue;
    if (assetFiles.has(file.fileName)) {
      // Data, not code: a route manifest staged as a text module can be
      // megabytes. Hashed as bytes, never scanned.
      hashable.set(file.fileName, sha256(onDisk));
      continue;
    }
    const text = portableRegions(decoder.decode(onDisk), projectRoot);
    const source = file.holdsServerReferences
      ? stripServerReferenceMap(text)
      : text;
    const parts: Array<string | ServerFile> = [];
    const targets = new Set<ServerFile>();
    let last = 0;
    if (reference) {
      for (const match of source.matchAll(reference)) {
        const target = identityByBaseName.get(match[0])!;
        parts.push(source.slice(last, match.index), target);
        last = match.index + match[0].length;
        targets.add(target);
      }
    }
    if (parts.length === 0) {
      hashable.set(file.fileName, sha256(source));
      continue;
    }
    parts.push(source.slice(last));
    hashable.set(file.fileName, {
      parts,
      targets: [...targets],
      digests: new Map(),
    });
    const named = [...targets]
      .filter((target) => assetFiles.has(target.fileName))
      .map((target) => target.fileName);
    if (named.length > 0) assetsNamedBy.set(file.fileName, named);
  }

  const keyFile = input.readServerFile(ENCRYPTION_KEY_FILE);
  const members = resolveRouterMembers(server, input.client, input.routers);

  // A Static payload or a clientUrls() projection belongs to every router
  // that reaches its module; one whose module no router reaches belongs to
  // all of them.
  const claimedByModule = new Set<BuildDataRecord>();
  for (const record of input.buildData) {
    if (record.kind === "prerender" || record.moduleId === undefined) continue;
    for (const member of members.values()) {
      if (member.modules.has(record.moduleId)) {
        claimedByModule.add(record);
        break;
      }
    }
  }
  const ownsBuildData = (
    record: BuildDataRecord,
    routerId: string,
    member: RouterMembers,
  ): boolean => {
    if (record.kind === "prerender") {
      return record.routerId === undefined || record.routerId === routerId;
    }
    return (
      !claimedByModule.has(record) ||
      (record.moduleId !== undefined && member.modules.has(record.moduleId))
    );
  };

  // A server component's stylesheets belong to every router that can run the
  // component; an entry whose module no router reaches belongs to all of them.
  const serverResources = input.serverResources ?? new Map<string, string>();
  const resourcesOf = new Map<string, Set<string>>();
  const claimedResources = new Set<string>();
  if (serverResources.size > 0) {
    // The links are rendered by plugin-rsc's CSS module for the entry
    // (`virtual:vite-rsc/css?type=rsc&id=<module the entry is keyed by>`),
    // which is what a router has to reach. With an explicit
    // `import.meta.viteRsc.loadCss("./other")` that is not the keyed module.
    const resourceOfModule = new Map<string, string>();
    for (const id of server.modules.keys()) {
      const key = portableModuleId(id, projectRoot).match(
        SERVER_CSS_MODULE,
      )?.[1];
      if (key !== undefined && serverResources.has(key)) {
        resourceOfModule.set(id, key);
      }
    }
    for (const [routerId, member] of members) {
      const keys = new Set<string>();
      for (const [id, key] of resourceOfModule) {
        if (member.modules.has(id)) {
          keys.add(key);
          claimedResources.add(key);
        }
      }
      resourcesOf.set(routerId, keys);
    }
  }

  const externalsOf = new Map<string, string[]>();
  for (const chunk of server.chunks) {
    const packages = (chunk.externalImports ?? [])
      .map(externalPackage)
      .filter((name) => name !== undefined);
    if (packages.length > 0) externalsOf.set(chunk.fileName, packages);
  }

  const encrypts = (modules: Iterable<string>): boolean => {
    for (const id of modules) {
      if (server.modules.get(id)?.encryptsBoundArgs) return true;
    }
    return false;
  };

  const table: Record<string, readonly [string, string]> = {};
  const details: RouterVersionDetail[] = [];
  const add = (
    routerId: string,
    chunkFiles: Iterable<string>,
    usesEncryptionKey: boolean,
    buildData: readonly BuildDataRecord[],
  ): void => {
    const owned = new Set(chunkFiles);
    for (const fileName of [...owned]) {
      for (const asset of assetsNamedBy.get(fileName) ?? []) owned.add(asset);
    }

    const dataInputs: VersionInput[] = [];
    const externals = new Set<string>();
    for (const file of files) {
      const content = hashable.get(file.fileName);
      if (content === undefined || !owned.has(file.fileName)) continue;
      dataInputs.push([
        `file ${file.identity}`,
        typeof content === "string" ? content : digestFile(content, owned),
      ]);
      for (const name of externalsOf.get(file.fileName) ?? []) {
        externals.add(name);
      }
    }
    for (const name of externals) {
      const installed = input.describeExternal?.(name);
      if (installed !== undefined) {
        dataInputs.push([`external ${name}`, sha256(installed)]);
      }
    }
    const ownResources = resourcesOf.get(routerId);
    for (const [key, entry] of serverResources) {
      if (
        routerId === DEFAULT_ROUTER_VERSIONS_KEY ||
        ownResources?.has(key) ||
        !claimedResources.has(key)
      ) {
        dataInputs.push([`server-css ${key}`, sha256(entry)]);
      }
    }
    if (usesEncryptionKey && keyFile !== undefined) {
      dataInputs.push(["encryption-key", sha256(keyFile)]);
    }
    const documentInputs: VersionInput[] = [
      ["ssr-and-client", input.documentDigest],
    ];
    for (const record of buildData) {
      (record.kind === "prerender" ? documentInputs : dataInputs).push([
        `${record.kind} ${record.key}`,
        record.digest,
      ]);
    }
    dataInputs.sort(byName);
    documentInputs.sort(byName);

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
      usesEncryptionKey,
    });
  };

  for (const router of input.routers) {
    const member = members.get(router.id);
    if (!member) continue;
    add(
      router.id,
      member.chunkFiles,
      encrypts(member.modules),
      input.buildData.filter((record) =>
        ownsBuildData(record, router.id, member),
      ),
    );
  }
  add(
    DEFAULT_ROUTER_VERSIONS_KEY,
    files.map((file) => file.fileName),
    encrypts(server.modules.keys()),
    input.buildData,
  );
  return { table, details };
}

/**
 * Digest of what stored HTML depends on besides a router's server code: the
 * SSR output (it renders the HTML, and its own code can change without the
 * client's) and the client asset names (a prelude and an open tab both hold
 * them, and the names carry the bundler's content hashes).
 */
export function digestDocumentInputs(input: {
  /** SSR output files, path relative to the SSR output directory. */
  readonly ssrFiles: ReadonlyArray<{ fileName: string; source: Uint8Array }>;
  readonly clientFileNames: readonly string[];
  readonly base: string;
  /**
   * Packages the SSR output leaves external, with what is installed for each
   * ({@link ComputeRouterVersionsInput.describeExternal}).
   */
  readonly ssrExternals?: ReadonlyArray<readonly [name: string, text: string]>;
}): string {
  const hash = createHash("sha256");
  hash.update(`base\0${input.base}`);
  hash.update(
    `\0externals\0${JSON.stringify([...(input.ssrExternals ?? [])].sort(byName))}`,
  );
  const ssrFiles = [...input.ssrFiles].sort((a, b) =>
    compareStrings(a.fileName, b.fileName),
  );
  for (const file of ssrFiles) {
    // Length-prefixed: file bytes are arbitrary, so a separator alone could
    // not tell one file's end from the next entry's header.
    hash.update(`\0ssr\0${file.fileName}\0${file.source.byteLength}\0`);
    hash.update(file.source);
  }
  for (const fileName of [...input.clientFileNames].sort()) {
    hash.update(`\0client\0${fileName}`);
  }
  return hash.digest("hex");
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
