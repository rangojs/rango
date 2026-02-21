import type { Plugin, PluginOption } from "vite";
import { createServer as createViteServer } from "vite";
import * as Vite from "vite";
import { resolve, join, dirname, basename, relative, posix } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import {
  generateRouteTypesSource,
  writeCombinedRouteTypes,
  findRouterFiles,
  createScanFilter,
  buildCombinedRouteMapForRouterFile,
  type ScanFilter,
} from "../build/generate-route-types.ts";
import { exposeActionId } from "./expose-action-id.ts";
import { exposeInternalIds, exposeRouterId } from "./expose-internal-ids.ts";
import {
  VIRTUAL_ENTRY_BROWSER,
  VIRTUAL_ENTRY_SSR,
  getVirtualEntryRSC,
  getVirtualVersionContent,
  VIRTUAL_IDS,
} from "./virtual-entries.ts";
import {
  getExcludeDeps,
  getPackageAliases,
  getPublishedPackageName,
} from "./package-resolution.ts";
import { skipStringOrComment, escapeRegExp } from "./expose-id-utils.ts";

// Re-export plugins
export { exposeActionId } from "./expose-action-id.ts";
export { exposeInternalIds, exposeRouterId } from "./expose-internal-ids.ts";
export type { ExposeInternalIdsApi } from "./expose-internal-ids.ts";

// Virtual module type declarations in ./version.d.ts

/**
 * esbuild plugin to provide rsc-router:version virtual module during optimization.
 * This is needed because esbuild runs during Vite's dependency optimization phase,
 * before Vite's plugin system can handle virtual modules.
 */
const versionEsbuildPlugin = {
  name: "@rangojs/router-version",
  setup(build: any) {
    build.onResolve({ filter: /^rsc-router:version$/ }, (args: any) => ({
      path: args.path,
      namespace: "@rangojs/router-virtual",
    }));
    build.onLoad({ filter: /.*/, namespace: "@rangojs/router-virtual" }, () => ({
      contents: `export const VERSION = "dev";`,
      loader: "js",
    }));
  },
};

/**
 * Shared esbuild options for dependency optimization.
 * Includes the version stub plugin for all environments.
 */
const sharedEsbuildOptions = {
  plugins: [versionEsbuildPlugin],
};

// Dev-mode client-reference key prefixes emitted by @vitejs/plugin-rsc
const CLIENT_PKG_PROXY_PREFIX = "/@id/__x00__virtual:vite-rsc/client-package-proxy/";
const CLIENT_IN_SERVER_PKG_PROXY_PREFIX = "/@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/";
const FS_PREFIX = "/@fs/";

/**
 * Compute the production SHA-256 hash for a dev-mode client reference key.
 * Mirrors the hashing logic in @vitejs/plugin-rsc's build mode:
 *   - Local files: hashString(toRelativeId(id)) where toRelativeId = relative(root, id)
 *   - Package proxies: hashString(packageSource)
 *   - client-in-server-package proxies: hashString(relative(root, decodedAbsPath))
 *
 * Returns the input unchanged if it doesn't match a known dev-mode pattern
 * (e.g., already a production hash).
 */
export function computeProductionHash(projectRoot: string, refKey: string): string {
  let toHash: string;

  if (refKey.startsWith(CLIENT_PKG_PROXY_PREFIX)) {
    // /@id/__x00__virtual:vite-rsc/client-package-proxy/<pkg> -> hash("<pkg>")
    toHash = refKey.slice(CLIENT_PKG_PROXY_PREFIX.length);
  } else if (refKey.startsWith(CLIENT_IN_SERVER_PKG_PROXY_PREFIX)) {
    // /@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/<encodedAbsPath>
    const absPath = decodeURIComponent(refKey.slice(CLIENT_IN_SERVER_PKG_PROXY_PREFIX.length));
    toHash = posix.normalize(relative(projectRoot, absPath));
  } else if (refKey.startsWith(FS_PREFIX)) {
    // /@fs/abs/path.tsx -> hash(relative(root, "/abs/path.tsx"))
    const absPath = refKey.slice(FS_PREFIX.length - 1); // keep leading /
    toHash = posix.normalize(relative(projectRoot, absPath));
  } else if (refKey.startsWith("/")) {
    // /src/Button.tsx -> hash("src/Button.tsx")
    toHash = refKey.slice(1);
  } else {
    // Already hashed or unknown format — return unchanged
    return refKey;
  }

  return createHash("sha256").update(toHash).digest("hex").slice(0, 12);
}

// Regex to match registerClientReference() calls as emitted by @vitejs/plugin-rsc.
// Captures the reference key (second argument) from the call.
// Handles two proxy forms: parenthesized expression `(expr)` and arrow-throw `() => { ... }`.
const REGISTER_CLIENT_REF_RE = /registerClientReference\(\s*(?:(?:\([^)]*\))|(?:\(\)[\s\S]*?\}))\s*,\s*"([^"]+)"\s*,\s*"[^"]+"\s*\)/g;

/**
 * Transform source code by replacing dev-mode client reference keys with
 * production hashes. Exported for testing; used internally by hashClientRefs.
 * Returns null if no replacements were made.
 */
export function transformClientRefs(
  code: string,
  projectRoot: string,
): string | null {
  if (!code.includes("registerClientReference")) return null;

  let hasReplacement = false;
  const result = code.replace(REGISTER_CLIENT_REF_RE, (match, refKey: string) => {
    const hash = computeProductionHash(projectRoot, refKey);
    if (hash === refKey) return match;
    hasReplacement = true;
    return match.replace(`"${refKey}"`, `"${hash}"`);
  });

  return hasReplacement ? result : null;
}

/**
 * Vite plugin that rewrites registerClientReference() calls in the RSC
 * environment, replacing dev-mode reference keys with production hashes.
 *
 * This runs AFTER the RSC plugin's transform so the Flight serializer
 * naturally emits production IDs, eliminating the need for post-build
 * regex replacement of Flight payloads.
 */
function hashClientRefs(projectRoot: string): Plugin {
  return {
    name: "@rangojs/router:hash-client-refs",
    // Run after the RSC plugin's transform (default enforce is normal)
    enforce: "post",
    applyToEnvironment(env) {
      return env.name === "rsc";
    },
    transform(code, _id) {
      const result = transformClientRefs(code, projectRoot);
      if (result === null) return;
      return { code: result, map: null };
    },
  };
}

/**
 * RSC plugin entry points configuration.
 * All entries use virtual modules by default. Specify a path to use a custom entry file.
 */
export interface RscEntries {
  /**
   * Path to a custom browser/client entry file.
   * If not specified, a default virtual entry is used.
   */
  client?: string;

  /**
   * Path to a custom SSR entry file.
   * If not specified, a default virtual entry is used.
   */
  ssr?: string;

  /**
   * Path to a custom RSC entry file.
   * If not specified, a default virtual entry is used that imports the router from the `entry` option.
   */
  rsc?: string;
}

/**
 * Options for @vitejs/plugin-rsc integration
 */
export interface RscPluginOptions {
  /**
   * Entry points for client, ssr, and rsc environments.
   * All entries use virtual modules by default.
   * Specify paths only when you need custom entry files.
   */
  entries?: RscEntries;
}

/**
 * Base options shared by all presets
 */
interface RangoBaseOptions {
  /**
   * Show startup banner. Set to false to disable.
   * @default true
   */
  banner?: boolean;

  /**
   * Generate named-routes.gen.ts by parsing url modules at startup.
   * Provides type-safe Handler<"name"> and href() without executing router code.
   * Set to `false` to disable (run `npx rango extract-names` manually instead).
   * @default true
   */
  staticRouteTypesGeneration?: boolean;

  /**
   * Glob patterns for files to include in route type scanning.
   * Only files matching at least one pattern will be scanned.
   * Patterns are relative to the project root.
   * When unset, all .ts/.tsx files are scanned.
   */
  include?: string[];

  /**
   * Glob patterns for files to exclude from route type scanning.
   * Takes precedence over `include`. Patterns are relative to the project root.
   * Defaults to common test/build directories.
   */
  exclude?: string[];
}

/**
 * Options for Node.js deployment (default)
 */
export interface RangoNodeOptions extends RangoBaseOptions {
  /**
   * Deployment preset. Defaults to 'node' when not specified.
   */
  preset?: "node";

  /**
   * Path to your router configuration file that exports the route tree.
   * This file must export a `router` object created with `createRouter()`.
   *
   * When omitted, auto-discovers the router by scanning for files containing
   * `createRouter`. If exactly one is found, it is used automatically.
   * If multiple are found, an error is thrown with the list of candidates.
   *
   * @example
   * ```ts
   * rango({ router: './src/router.tsx' })
   * // or simply:
   * rango()
   * ```
   */
  router?: string;

  /**
   * RSC plugin configuration. By default, rsc-router includes @vitejs/plugin-rsc
   * with sensible defaults.
   *
   * Entry files (browser, ssr, rsc) are optional - if they don't exist,
   * virtual defaults are used.
   *
   * - Omit or pass `true`/`{}` to use defaults (recommended)
   * - Pass `{ entries: {...} }` to customize entry paths
   * - Pass `false` to disable (for manual @vitejs/plugin-rsc configuration)
   *
   * @default true
   */
  rsc?: boolean | RscPluginOptions;
}

/**
 * Options for Cloudflare Workers deployment
 */
export interface RangoCloudflareOptions extends RangoBaseOptions {
  /**
   * Deployment preset for Cloudflare Workers.
   * When using cloudflare preset:
   * - @vitejs/plugin-rsc is NOT added (cloudflare plugin adds it)
   * - Your worker entry (e.g., worker.rsc.tsx) imports the router directly
   * - Browser and SSR use virtual entries
   * - Build-time manifest generation is auto-detected from wrangler.json main entry
   */
  preset: "cloudflare";
}

/**
 * Options for rango() Vite plugin
 */
export type RangoOptions = RangoNodeOptions | RangoCloudflareOptions;

/**
 * Create a virtual modules plugin for default entry files.
 * Provides virtual module content when entries use VIRTUAL_IDS (no custom entry configured).
 */
function createVirtualEntriesPlugin(
  entries: { client: string; ssr: string; rsc?: string },
  routerPath?: string
): Plugin {

  // Build virtual modules map based on which entries use virtual IDs
  const virtualModules: Record<string, string> = {};

  if (entries.client === VIRTUAL_IDS.browser) {
    virtualModules[VIRTUAL_IDS.browser] = VIRTUAL_ENTRY_BROWSER;
  }
  if (entries.ssr === VIRTUAL_IDS.ssr) {
    virtualModules[VIRTUAL_IDS.ssr] = VIRTUAL_ENTRY_SSR;
  }
  if (entries.rsc === VIRTUAL_IDS.rsc && routerPath) {
    // Convert relative path to absolute for virtual module imports
    const absoluteRouterPath = routerPath.startsWith(".")
      ? "/" + routerPath.slice(2) // ./src/router.tsx -> /src/router.tsx
      : routerPath;
    virtualModules[VIRTUAL_IDS.rsc] = getVirtualEntryRSC(absoluteRouterPath);
  }

  return {
    name: "@rangojs/router:virtual-entries",
    enforce: "pre",

    resolveId(id) {
      if (id in virtualModules) {
        return "\0" + id;
      }
      // Handle if the id already has the null prefix (RSC plugin wrapper imports)
      if (id.startsWith("\0") && id.slice(1) in virtualModules) {
        return id;
      }
      return null;
    },

    load(id) {
      if (id.startsWith("\0virtual:rsc-router/")) {
        const virtualId = id.slice(1);
        if (virtualId in virtualModules) {
          return virtualModules[virtualId];
        }
      }
      return null;
    },
  };
}

/**
 * Rollup onwarn handler that suppresses known harmless warnings:
 * - "use client" directives: handled by the RSC plugin, not relevant to Rollup
 * - sourcemap errors: caused by "use client" directive at line 1:0 confusing sourcemap resolution
 * - sourcemap incomplete: plugins that transform without generating sourcemaps (router + RSC plugin)
 * - dynamic/static mixed imports: expected for router internals (e.g. request-context, cache-scope)
 * - empty bundle: @vitejs/plugin-rsc scan build (step 1/5) produces an empty "index" chunk
 *   because the RSC entry is fully externalized during client-reference analysis
 */
function onwarn(warning: Vite.Rollup.RollupLog, defaultHandler: (warning: Vite.Rollup.RollupLog) => void): void {
  if (warning.code === "MODULE_LEVEL_DIRECTIVE" || warning.code === "SOURCEMAP_ERROR" || warning.code === "EMPTY_BUNDLE") {
    return;
  }
  // @vitejs/plugin-rsc@0.5.14: rsc:virtual:vite-rsc/assets-manifest renderChunk
  // returns { code } without map, causing Rollup to warn about incorrect sourcemaps.
  // This is harmless (simple string replacement). Remove this suppression if a
  // future version of @vitejs/plugin-rsc fixes the missing sourcemap.
  if (warning.message?.includes("Sourcemap is likely to be incorrect")) {
    return;
  }
  if (
    warning.plugin === "vite:reporter" &&
    warning.message?.includes("dynamic import will not move module into another chunk")
  ) {
    return;
  }
  defaultHandler(warning);
}

/**
 * Manual chunks configuration for client build.
 * Splits React and router packages into separate chunks for better caching.
 */
function getManualChunks(id: string): string | undefined {
  const normalized = Vite.normalizePath(id);

  if (
    normalized.includes("node_modules/react/") ||
    normalized.includes("node_modules/react-dom/") ||
    normalized.includes("node_modules/react-server-dom-webpack/") ||
    normalized.includes("node_modules/@vitejs/plugin-rsc/")
  ) {
    return "react";
  }
  // Use dynamic package name from package.json
  // Check both npm install path and workspace symlink resolved path
  const packageName = getPublishedPackageName();
  if (
    normalized.includes(`node_modules/${packageName}/`) ||
    normalized.includes("packages/rsc-router/") ||
    normalized.includes("packages/rangojs-router/")
  ) {
    return "router";
  }
  return undefined;
}

/**
 * Plugin providing rsc-router:version virtual module.
 * Exports VERSION that changes when RSC modules change (dev) or at build time (production).
 *
 * The version is used for:
 * 1. Cache invalidation - CFCacheStore uses VERSION to invalidate stale cache
 * 2. Version mismatch detection - client sends version, server reloads on mismatch
 *
 * In dev mode, the version updates when:
 * - Server starts (initial version)
 * - RSC modules change via HMR (triggers version module invalidation)
 *
 * Client-only HMR changes don't update the version since they don't affect
 * server-rendered content or cached RSC payloads.
 * @internal
 */
function createVersionPlugin(): Plugin {
  // Generate version at plugin creation time (build/server start)
  const buildVersion = Date.now().toString(16);
  let currentVersion = buildVersion;
  let isDev = false;
  let server: any = null;

  return {
    name: "@rangojs/router:version",
    enforce: "pre",

    configResolved(config) {
      isDev = config.command === "serve";
    },

    configureServer(devServer) {
      server = devServer;
    },

    resolveId(id) {
      if (id === VIRTUAL_IDS.version) {
        return "\0" + id;
      }
      return null;
    },

    load(id) {
      if (id === "\0" + VIRTUAL_IDS.version) {
        return getVirtualVersionContent(currentVersion);
      }
      return null;
    },

    // Track RSC module changes and update version
    hotUpdate(ctx) {
      if (!isDev) return;

      // Check if this is an RSC environment update (not client/ssr)
      // RSC modules affect server-rendered content and cached payloads
      // In Vite 6, environment is accessed via `this.environment`
      const isRscModule = this.environment?.name === "rsc";

      if (isRscModule && ctx.modules.length > 0) {
        // Update version when RSC modules change
        currentVersion = Date.now().toString(16);
        console.log(
          `[rsc-router] RSC module changed, version updated: ${currentVersion}`
        );

        // Invalidate the version module so it gets reloaded with new version
        if (server) {
          const rscEnv = server.environments?.rsc;
          if (rscEnv?.moduleGraph) {
            const versionMod = rscEnv.moduleGraph.getModuleById(
              "\0" + VIRTUAL_IDS.version
            );
            if (versionMod) {
              rscEnv.moduleGraph.invalidateModule(versionMod);
            }
          }
        }
      }
    },
  };
}

/**
 * Flatten prefix tree leaf nodes into precomputed route entries.
 * Leaf nodes have no children (no nested includes), so their routes can be
 * used directly by evaluateLazyEntry() without running the handler.
 * Non-leaf nodes are skipped because they have nested lazy includes that
 * require the handler to run for discovery.
 */
function flattenLeafEntries(
  prefixTree: Record<string, any>,
  routeManifest: Record<string, string>,
  result: Array<{ staticPrefix: string; routes: Record<string, string> }>,
): void {
  function visit(node: any): void {
    const children = node.children || {};
    if (Object.keys(children).length === 0 && node.routes && node.routes.length > 0) {
      // Leaf node: collect its routes from the manifest
      const routes: Record<string, string> = {};
      for (const name of node.routes) {
        if (name in routeManifest) {
          routes[name] = routeManifest[name];
        }
      }
      result.push({ staticPrefix: node.staticPrefix, routes });
    } else {
      // Non-leaf: recurse into children
      for (const child of Object.values(children)) {
        visit(child);
      }
    }
  }
  for (const node of Object.values(prefixTree)) {
    visit(node);
  }
}

/**
 * Walk prefix tree to map each route name to its scope's staticPrefix.
 */
function buildRouteToStaticPrefix(
  prefixTree: Record<string, any>,
  result: Record<string, string>,
): void {
  function visit(node: any): void {
    const sp = node.staticPrefix || "";
    for (const name of (node.routes || [])) {
      result[name] = sp;
    }
    for (const child of Object.values(node.children || {})) {
      visit(child);
    }
  }
  for (const node of Object.values(prefixTree)) {
    visit(node);
  }
}

/**
 * Find matching close paren in bundled code using depth counting.
 * Uses skipStringOrComment from expose-id-utils to correctly handle
 * template literal ${...} expressions, comments, and nested strings.
 * Returns the position after the closing paren, or -1 if unmatched.
 * @internal Exported for testing only.
 */
export function findMatchingParenInBundle(code: string, openParenPos: number): number {
  let depth = 1;
  let pos = openParenPos;
  while (pos < code.length && depth > 0) {
    const skipped = skipStringOrComment(code, pos);
    if (skipped > pos) {
      pos = skipped;
      continue;
    }
    if (code[pos] === "(") depth++;
    else if (code[pos] === ")") depth--;
    pos++;
  }
  return depth === 0 ? pos : -1;
}

/**
 * Scan a bundled chunk for handler exports of a given type and extract
 * their names + $$id values. Optionally detects passthrough flag.
 * @internal Exported for testing only.
 */
export function extractHandlerExportsFromChunk(
  chunkCode: string,
  handlerModules: Map<string, string[]>,
  fnName: string,
  detectPassthrough: boolean,
): Array<{ name: string; handlerId: string; passthrough: boolean }> {
  const handlers: Array<{ name: string; handlerId: string; passthrough: boolean }> = [];

  for (const [, handlerNames] of handlerModules) {
    for (const name of handlerNames) {
      const eName = escapeRegExp(name);
      const idPattern = new RegExp(
        `(?<![a-zA-Z0-9_])${eName}\\.\\$\\$id\\s*=\\s*"([^"]+)"`,
      );
      const match = chunkCode.match(idPattern);
      if (!match) continue;

      let isPassthrough = false;
      if (detectPassthrough) {
        const eFnName = escapeRegExp(fnName);
        const callStartRe = new RegExp(
          `const\\s+${eName}\\s*=\\s*${eFnName}\\s*(?:<[^>]*>)?\\s*\\(`,
        );
        const callStart = callStartRe.exec(chunkCode);
        if (callStart) {
          const afterOpen = callStart.index + callStart[0].length;
          const closePos = findMatchingParenInBundle(chunkCode, afterOpen);
          if (closePos !== -1) {
            const callBody = chunkCode.slice(callStart.index, closePos);
            isPassthrough = /passthrough\s*:\s*(!0|true)/.test(callBody);
          }
        }
      }
      handlers.push({ name, handlerId: match[1], passthrough: isPassthrough });
    }
  }

  return handlers;
}

/**
 * Evict handler code from a bundled chunk, replacing full handler call
 * expressions with lightweight stub objects. Returns the modified code
 * and bytes saved, or null if no changes were made.
 * @internal Exported for testing only.
 */
export function evictHandlerCode(
  code: string,
  exports: Array<{ name: string; handlerId: string; passthrough?: boolean }>,
  fnName: string,
  brand: string,
): { code: string; savedBytes: number } | null {
  const originalSize = Buffer.byteLength(code);
  let modified = code;

  const eFnName = escapeRegExp(fnName);
  for (const { name, handlerId, passthrough } of exports) {
    if (passthrough) continue;

    const eName = escapeRegExp(name);
    const callStartRe = new RegExp(
      `const\\s+${eName}\\s*=\\s*${eFnName}\\s*(?:<[^>]*>)?\\s*\\(`,
    );
    const startMatch = callStartRe.exec(modified);
    if (!startMatch) continue;

    const afterOpen = startMatch.index + startMatch[0].length;
    const closePos = findMatchingParenInBundle(modified, afterOpen);
    if (closePos === -1) continue;

    // Skip trailing whitespace and optional semicolon
    let rangeEnd = closePos;
    while (rangeEnd < modified.length && /\s/.test(modified[rangeEnd])) rangeEnd++;
    if (modified[rangeEnd] === ";") rangeEnd++;

    // Validate: matched range must contain the expected handlerId
    const matched = modified.slice(startMatch.index, rangeEnd);
    if (!matched.includes(handlerId)) continue;

    const stub = `const ${name} = { __brand: "${brand}", $$id: "${handlerId}" };`;
    modified = modified.slice(0, startMatch.index) + stub + modified.slice(rangeEnd);

    // Remove the now-redundant $$id assignment line.
    modified = modified.replace(
      new RegExp(`\\n${eName}\\.\\$\\$id\\s*=\\s*"[^"]+";`),
      "",
    );
  }

  if (modified === code) return null;
  return { code: modified, savedBytes: originalSize - Buffer.byteLength(modified) };
}

/**
 * Encode route param values for path interpolation while preserving path
 * separators for wildcard params (splat-style values can include `/`).
 */
function encodePathParam(value: unknown): string {
  return String(value)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Plugin that discovers router instances at dev/build time via the RSC environment.
 *
 * Uses `server.environments.rsc.runner.import()` to load the user's router file
 * with full TS/TSX compilation. This triggers `createRouter()` which populates
 * the `RouterRegistry`. The plugin then generates manifests for each router.
 *
 * In dev mode, this runs in `configureServer` (post-middleware setup).
 * In build mode, this will run in `buildStart` (future).
 *
 * @internal
 */
function createRouterDiscoveryPlugin(
  entryPath: string,
  opts?: { enableBuildPrerender?: boolean; staticRouteTypesGeneration?: boolean; include?: string[]; exclude?: string[] },
): Plugin {
  let projectRoot = "";
  let isBuildMode = false;
  let userResolveAlias: any = undefined;

  // Scan filter compiled from include/exclude patterns (created in configResolved)
  let scanFilter: ScanFilter | undefined;

  // Cached router file paths (files containing createRouter) from initial scan.
  // Reused by the file watcher to avoid re-scanning the entire directory tree.
  let cachedRouterFiles: string[] | undefined;

  // Merged route manifest from all discovered routers.
  // Populated during discovery (dev: configureServer, build: buildStart).
  // Read by the virtual module's load hook to emit setCachedManifest() call.
  let mergedRouteManifest: Record<string, string> | null = null;

  // Per-router route manifests for generating typed route files.
  let perRouterManifests: Array<{
    id: string;
    routeManifest: Record<string, string>;
    routeSearchSchemas?: Record<string, Record<string, string>>;
    sourceFile?: string;
    factoryOnlyPrefixes?: Set<string>;
  }> = [];

  // Collected prerender data from in-process collection during discoverRouters().
  // Consumed by closeBundle to inject into the RSC entry bundle.
  let prerenderCollectedData: Record<string, any> | null = null;

  // Handler chunk metadata recorded during generateBundle for post-build eviction.
  let handlerChunkInfo: {
    fileName: string;
    exports: Array<{ name: string; handlerId: string; passthrough: boolean }>;
  } | null = null;

  // RSC entry chunk filename recorded during generateBundle for closeBundle injection.
  let rscEntryFileName: string | null = null;

  // Collected static handler data: handlerId -> { encoded Flight payload, handle data }.
  let staticCollectedData: Record<string, { encoded: string; handles: Record<string, unknown[]> }> | null = null;

  // Handler chunk info for __static-handlers, populated by generateBundle.
  let staticHandlerChunkInfo: {
    fileName: string;
    exports: Array<{ name: string; handlerId: string; passthrough: boolean }>;
  } | null = null;

  // Resolved prerender handler modules from the expose-internal-ids plugin.
  let resolvedPrerenderModules: Map<string, string[]> | undefined;

  // Resolved static handler modules from the expose-internal-ids plugin.
  let resolvedStaticModules: Map<string, string[]> | undefined;

  // Promise that resolves when dev-mode discovery completes.
  // The virtual module's load hook awaits this to ensure data is available.
  let discoveryDone: Promise<void> | null = null;

  // Pre-computed route entries from prefix tree leaf nodes.
  // Leaf nodes have no nested includes, so their routes can be used directly
  // by evaluateLazyEntry() without running the handler.
  let mergedPrecomputedEntries: Array<{
    staticPrefix: string;
    routes: Record<string, string>;
  }> | null = null;

  // Route trie for O(path_length) matching at runtime.
  let mergedRouteTrie: any = null;

  // Per-router isolated data for multi-router manifest splitting.
  // Each router gets its own manifest, trie, and precomputed entries so that
  // virtual:rsc-router/routes-manifest/<routerId> modules can be emitted.
  let perRouterTrieMap: Map<string, any> = new Map();
  let perRouterPrecomputedMap: Map<string, Array<{ staticPrefix: string; routes: Record<string, string> }>> = new Map();
  let perRouterManifestDataMap: Map<string, Record<string, string>> = new Map();

  // Dev-mode state for on-demand prerender endpoint.
  let devServerOrigin: string | null = null;
  let devServer: any = null;

  // Shared discovery logic: import entry via RSC runner, generate manifests,
  // write static files, and populate mergedRouteManifest.
  async function discoverRouters(rscEnv: any) {
    // Import the entry file via RSC environment.
    // For node preset: this is the router file (createRouter() registers in RouterRegistry).
    // For cloudflare preset: this is the worker entry (which imports the router).
    await rscEnv.runner.import(entryPath);

    // Import the router package to access the registry
    const serverMod = await rscEnv.runner.import("@rangojs/router/server");
    let registry: Map<string, any> = serverMod.RouterRegistry;

    if (!registry || registry.size === 0) {
      // No RSC routers found directly. Check for host routers with lazy handlers
      // that need to be resolved to trigger sub-app createRouter() calls.
      try {
        const hostMod = await rscEnv.runner.import("@rangojs/router/host");
        const hostRegistry: Map<string, any> | undefined = hostMod.HostRouterRegistry;

        if (hostRegistry && hostRegistry.size > 0) {
          console.log(
            `[rsc-router] Found ${hostRegistry.size} host router(s), resolving lazy handlers...`
          );

          for (const [, entry] of hostRegistry) {
            for (const route of entry.routes) {
              if (typeof route.handler === 'function') {
                try {
                  await route.handler();
                } catch {
                  // Lazy handler may fail in temp server context, that's OK
                }
              }
            }
            if (entry.fallback && typeof entry.fallback.handler === 'function') {
              try {
                await entry.fallback.handler();
              } catch {
                // Fallback handler may fail in temp server context
              }
            }
          }

          // Re-read RouterRegistry - sub-app createRouter() calls should have populated it
          const freshServerMod = await rscEnv.runner.import("@rangojs/router/server");
          const freshRegistry: Map<string, any> = freshServerMod.RouterRegistry;

          if (freshRegistry && freshRegistry.size > 0) {
            // Update references so the manifest generation below uses the fresh data
            Object.assign(serverMod, freshServerMod);
            registry = freshRegistry;
          }
        }
      } catch {
        // @rangojs/router/host not available or import failed, skip
      }

      // If still no routers after host router resolution, fail
      if (!registry || registry.size === 0) {
        throw new Error(
          `[rsc-router] No routers found in registry after importing ${entryPath}`
        );
      }
    }

    // Import build utilities for manifest generation
    const buildMod = await rscEnv.runner.import("@rangojs/router/build");
    const generateManifest = buildMod.generateManifest;

    mergedRouteManifest = {};
    mergedPrecomputedEntries = [];
    perRouterManifests = [];
    perRouterManifestDataMap = new Map();
    perRouterPrecomputedMap = new Map();
    perRouterTrieMap = new Map();
    let mergedRouteAncestry: Record<string, string[]> = {};
    let mergedRouteTrailingSlash: Record<string, string> = {};

    let routerMountIndex = 0;
    // Collect all manifests for trie building (avoid re-running generateManifest)
    const allManifests: Array<{ id: string; manifest: any }> = [];

    for (const [id, router] of registry) {
      if (!router.urlpatterns || !generateManifest) {
        continue;
      }

      const manifest = generateManifest(router.urlpatterns, routerMountIndex);
      routerMountIndex++;
      allManifests.push({ id, manifest });
      const routeCount = Object.keys(manifest.routeManifest).length;
      const staticRoutes = Object.values(manifest.routeManifest).filter(
        (p: any) => !p.includes(":") && !p.includes("*")
      ).length;
      const dynamicRoutes = routeCount - staticRoutes;

      // Merge into the combined manifest
      Object.assign(mergedRouteManifest, manifest.routeManifest);
      // Compute factory-only prefixes: dot-prefixed groups in the runtime
      // manifest that the static parser cannot see. These are routes created
      // by factory functions (e.g. createDocsPatterns()) and should always be
      // supplemented on file change since HMR won't re-discover them.
      let factoryOnlyPrefixes: Set<string> | undefined;
      if (router.__sourceFile) {
        const staticParsed = buildCombinedRouteMapForRouterFile(router.__sourceFile);
        const staticNames = new Set(Object.keys(staticParsed.routes));
        factoryOnlyPrefixes = new Set<string>();
        for (const name of Object.keys(manifest.routeManifest)) {
          if (staticNames.has(name)) continue;
          const dotIdx = name.indexOf(".");
          if (dotIdx <= 0) continue;
          const prefix = name.substring(0, dotIdx + 1);
          if ([...staticNames].some(n => n.startsWith(prefix))) continue;
          factoryOnlyPrefixes.add(prefix);
        }
        if (factoryOnlyPrefixes.size === 0) factoryOnlyPrefixes = undefined;
      }

      perRouterManifests.push({
        id,
        routeManifest: manifest.routeManifest,
        routeSearchSchemas: manifest.routeSearchSchemas,
        sourceFile: router.__sourceFile,
        factoryOnlyPrefixes,
      });

      // Merge ancestry (internal field, used only for trie building)
      if (manifest._routeAncestry) {
        Object.assign(mergedRouteAncestry, manifest._routeAncestry);
      }
      // Merge trailing slash config
      if (manifest.routeTrailingSlash) {
        Object.assign(mergedRouteTrailingSlash, manifest.routeTrailingSlash);
      }

      // Flatten prefix tree leaf nodes into precomputed entries.
      // Leaf nodes (no children) can have their routes used directly by
      // evaluateLazyEntry() without running the handler at runtime.
      flattenLeafEntries(manifest.prefixTree, manifest.routeManifest, mergedPrecomputedEntries);

      // Store per-router manifest and precomputed entries for isolated virtual modules.
      perRouterManifestDataMap.set(id, manifest.routeManifest);
      const routerPrecomputed: Array<{ staticPrefix: string; routes: Record<string, string> }> = [];
      flattenLeafEntries(manifest.prefixTree, manifest.routeManifest, routerPrecomputed);
      perRouterPrecomputedMap.set(id, routerPrecomputed);

      console.log(
        `[rsc-router] Router "${id}" -> ${routeCount} routes ` +
        `(${staticRoutes} static, ${dynamicRoutes} dynamic)`
      );
    }

    // Warn if multiple routers use auto-generated IDs (router_0, router_1, ...).
    // Auto-IDs are assigned by counter and depend on module evaluation order,
    // which can differ between build time and runtime (especially with dynamic
    // imports in host routers). This causes per-router data to be loaded into
    // the wrong router at runtime.
    if (registry.size > 1) {
      const autoIds = [...registry.keys()].filter((id) => /^router_\d+$/.test(id));
      if (autoIds.length > 1) {
        console.warn(
          `[rsc-router] WARNING: ${autoIds.length} routers use auto-generated IDs (${autoIds.join(", ")}). ` +
          `In multi-router setups, each createRouter() must have an explicit \`id\` option ` +
          `to ensure per-router manifest data is matched correctly at runtime. ` +
          `Example: createRouter({ id: "site", ... })`
        );
      }
    }

    // Build route trie from merged manifest + ancestry
    if (mergedRouteManifest && Object.keys(mergedRouteManifest).length > 0) {
      const buildRouteTrie = buildMod.buildRouteTrie;
      if (buildRouteTrie && mergedRouteAncestry) {
        // Build routeToStaticPrefix from saved manifests
        const routeToStaticPrefix: Record<string, string> = {};
        for (const { manifest } of allManifests) {
          // Root-level routes have empty static prefix
          for (const name of Object.keys(manifest.routeManifest)) {
            if (!(name in routeToStaticPrefix)) {
              routeToStaticPrefix[name] = "";
            }
          }
          buildRouteToStaticPrefix(manifest.prefixTree, routeToStaticPrefix);
        }

        // Collect prerender route names and response type routes from all manifests
        const prerenderRouteNames = new Set<string>();
        const passthroughRouteNames = new Set<string>();
        const mergedResponseTypeRoutes: Record<string, string> = {};
        for (const { manifest } of allManifests) {
          if (manifest.prerenderRoutes) {
            for (const name of manifest.prerenderRoutes) {
              prerenderRouteNames.add(name);
            }
          }
          if (manifest.passthroughRoutes) {
            for (const name of manifest.passthroughRoutes) {
              passthroughRouteNames.add(name);
            }
          }
          if (manifest.responseTypeRoutes) {
            Object.assign(mergedResponseTypeRoutes, manifest.responseTypeRoutes);
          }
        }

        mergedRouteTrie = buildRouteTrie(
          mergedRouteManifest,
          mergedRouteAncestry,
          routeToStaticPrefix,
          Object.keys(mergedRouteTrailingSlash).length > 0 ? mergedRouteTrailingSlash : undefined,
          prerenderRouteNames.size > 0 ? prerenderRouteNames : undefined,
          passthroughRouteNames.size > 0 ? passthroughRouteNames : undefined,
          Object.keys(mergedResponseTypeRoutes).length > 0 ? mergedResponseTypeRoutes : undefined,
        );

        // Build per-router tries for multi-router isolation.
        for (const { id, manifest } of allManifests) {
          if (!manifest._routeAncestry || Object.keys(manifest._routeAncestry).length === 0) continue;
          const perRouterStaticPrefix: Record<string, string> = {};
          for (const name of Object.keys(manifest.routeManifest)) {
            perRouterStaticPrefix[name] = "";
          }
          buildRouteToStaticPrefix(manifest.prefixTree, perRouterStaticPrefix);

          const perRouterPrerenderNames = manifest.prerenderRoutes
            ? new Set<string>(manifest.prerenderRoutes)
            : undefined;
          const perRouterPassthroughNames = manifest.passthroughRoutes
            ? new Set<string>(manifest.passthroughRoutes)
            : undefined;

          const perRouterTrie = buildRouteTrie(
            manifest.routeManifest,
            manifest._routeAncestry,
            perRouterStaticPrefix,
            manifest.routeTrailingSlash && Object.keys(manifest.routeTrailingSlash).length > 0
              ? manifest.routeTrailingSlash : undefined,
            perRouterPrerenderNames && perRouterPrerenderNames.size > 0 ? perRouterPrerenderNames : undefined,
            perRouterPassthroughNames && perRouterPassthroughNames.size > 0 ? perRouterPassthroughNames : undefined,
            manifest.responseTypeRoutes && Object.keys(manifest.responseTypeRoutes).length > 0
              ? manifest.responseTypeRoutes : undefined,
          );
          perRouterTrieMap.set(id, perRouterTrie);
        }
      }
    }

    // Expand prerender routes into concrete URLs for build-time rendering.
    // Static routes use pattern as-is; dynamic routes call getParams() to enumerate.
    if (opts?.enableBuildPrerender && isBuildMode) {
      const urls: string[] = [];
      for (const { manifest } of allManifests) {
        if (!manifest.prerenderRoutes) continue;
        const defs = manifest._prerenderDefs || {};
        for (const routeName of manifest.prerenderRoutes) {
          const pattern = manifest.routeManifest[routeName];
          if (!pattern) continue;
          const hasDynamic = pattern.includes(":") || pattern.includes("*");
          if (!hasDynamic) {
            // Static route: use pattern directly (strip trailing slash for URL)
            urls.push(pattern.replace(/\/$/, "") || "/");
          } else {
            // Dynamic route: call getParams() to enumerate param combinations
            const def = defs[routeName];
            if (def?.getParams) {
              try {
                const paramsList = await def.getParams();
                for (const params of paramsList) {
                  let url = pattern;
                  for (const [key, value] of Object.entries(params as Record<string, string>)) {
                    const encoded = encodePathParam(value);
                    url = url.replace(`:${key}`, encoded);
                    url = url.replace(`*${key}`, encoded);
                  }
                  // Anonymous wildcard fallback: use conventional keys if provided
                  if (url.includes("*")) {
                    const wildcardValue =
                      (params as Record<string, string>)["*"]
                      ?? (params as Record<string, string>).splat;
                    if (wildcardValue !== undefined) {
                      url = url.replace(/\*[^/]*$/, encodePathParam(wildcardValue));
                    }
                  }
                  urls.push(url.replace(/\/$/, "") || "/");
                }
              } catch (err: any) {
                console.warn(
                  `[rsc-router] Failed to get params for prerender route "${routeName}": ${err.message}`
                );
              }
            } else {
              console.warn(
                `[rsc-router] Dynamic prerender route "${routeName}" has no getParams(), skipping`
              );
            }
          }
        }
      }
      if (urls.length > 0) {
        console.log(
          `[rsc-router] Pre-render URLs: ${urls.join(", ")}`
        );

        const { hashParams } = await rscEnv.runner.import("@rangojs/router/build");

        const collectedData: Record<string, any> = {};
        let rendered = 0;

        for (const urlPath of urls) {
          // Try all routers since the URL->router mapping isn't direct
          for (const [, routerInstance] of registry) {
            if (!routerInstance.matchForPrerender) continue;
            try {
              const result = await routerInstance.matchForPrerender(urlPath, {});
              if (!result) continue;
              const paramHash = hashParams(result.params || {});
              collectedData[`${result.routeName}/${paramHash}`] = {
                segments: result.segments,
                handles: result.handles,
              };
              if (result.interceptSegments?.length) {
                collectedData[`${result.routeName}/${paramHash}/i`] = {
                  segments: [...result.segments, ...result.interceptSegments],
                  handles: { ...result.handles, ...(result.interceptHandles || {}) },
                };
              }
              rendered++;
              break;
            } catch (err: any) {
              console.warn(`[rsc-router] Pre-render failed for ${urlPath}: ${err.message}`);
            }
          }
        }

        if (rendered > 0) {
          prerenderCollectedData = collectedData;
          console.log(`[rsc-router] Pre-rendered ${rendered}/${urls.length} route(s)`);
        }
      }
    }

    // Render Static handlers at build time (segment-level, not route-level).
    // Each Static handler is called with a synthetic BuildContext and its
    // output is RSC-serialized. The encoded string is stored keyed by handler $$id.
    if (opts?.enableBuildPrerender && isBuildMode && resolvedStaticModules?.size) {
      const collected: Record<string, { encoded: string; handles: Record<string, unknown[]> }> = {};
      let staticRendered = 0;

      for (const [moduleId, exportNames] of resolvedStaticModules) {
        let mod: any;
        try {
          mod = await rscEnv!.runner.import(moduleId);
        } catch (err: any) {
          console.warn(`[rsc-router] Failed to import static module ${moduleId}: ${err.message}`);
          continue;
        }

        for (const name of exportNames) {
          const def = mod[name];
          if (!def || def.__brand !== "staticHandler" || !def.$$id) continue;
          // Passthrough handlers stay live in the bundle
          if (def.options?.passthrough) continue;

          let rendered = false;
          for (const [, routerInstance] of registry) {
            if (!routerInstance.renderStaticSegment) continue;
            try {
              const result = await routerInstance.renderStaticSegment(def.handler, def.$$id);
              if (result) {
                collected[def.$$id] = result;
                staticRendered++;
                rendered = true;
                break;
              }
            } catch (err: any) {
              console.warn(`[rsc-router] Static render failed for ${name}: ${err.message}`);
            }
          }
          if (!rendered) {
            console.warn(`[rsc-router] No router could render static handler "${name}"`);
          }
        }
      }

      if (staticRendered > 0) {
        staticCollectedData = collected;
        console.log(`[rsc-router] Rendered ${staticRendered} static handler(s)`);
      }
    }

    return serverMod;
  }

  // Write per-router named-routes type files next to each router's source file.
  // Each router gets its own {basename}.named-routes.gen.ts with only its routes.
  // Only writes when content has changed to avoid triggering HMR loops.
  function writeRouteTypesFiles() {
    if (perRouterManifests.length === 0) return;

    // Delete old combined named-routes.gen.ts if it exists
    try {
      const entryDir = dirname(resolve(projectRoot, entryPath));
      const oldCombinedPath = join(entryDir, "named-routes.gen.ts");
      if (existsSync(oldCombinedPath)) {
        unlinkSync(oldCombinedPath);
        console.log(`[rsc-router] Removed stale combined route types: ${oldCombinedPath}`);
      }
    } catch {}

    for (const { id, routeManifest, routeSearchSchemas, sourceFile } of perRouterManifests) {
      if (!sourceFile) continue;

      // Validate sourceFile points to a real project file, not node_modules or
      // a Vite internal path. A bad sourceFile leads to route types written to
      // the wrong location, causing non-deterministic type resolution.
      if (sourceFile.includes("node_modules")) {
        throw new Error(
          `[rsc-router] Router "${id}" has sourceFile inside node_modules: ${sourceFile}\n` +
          `This means createRouter() stack trace parsing matched a Vite internal frame.\n` +
          `Set an explicit \`id\` on createRouter() or check the call site.`,
        );
      }

      const routerDir = dirname(sourceFile);
      const routerBasename = basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
      const outPath = join(routerDir, `${routerBasename}.named-routes.gen.ts`);
      let effectiveSearchSchemas = routeSearchSchemas;

      // Runtime manifest may omit search schema metadata in some module-runner
      // flows. Fall back to static source parsing from the router file.
      if (
        (!effectiveSearchSchemas || Object.keys(effectiveSearchSchemas).length === 0) &&
        sourceFile
      ) {
        const staticParsed = buildCombinedRouteMapForRouterFile(sourceFile);
        if (Object.keys(staticParsed.searchSchemas).length > 0) {
          const filtered: Record<string, Record<string, string>> = {};
          for (const name of Object.keys(routeManifest)) {
            const schema = staticParsed.searchSchemas[name];
            if (schema) filtered[name] = schema;
          }
          if (Object.keys(filtered).length > 0) {
            effectiveSearchSchemas = filtered;
          }
        }
      }

      const source = generateRouteTypesSource(
        routeManifest,
        effectiveSearchSchemas && Object.keys(effectiveSearchSchemas).length > 0
          ? effectiveSearchSchemas
          : undefined,
      );
      const existing = existsSync(outPath) ? readFileSync(outPath, "utf-8") : null;
      if (existing !== source) {
        writeFileSync(outPath, source);
        console.log(`[rsc-router] Generated route types -> ${outPath}`);
      }
    }
  }

  // After the static parser writes a gen file, supplement it with route groups
  // from the runtime manifests that the static parser can't resolve (factory
  // calls like createDocsPatterns()). Only adds groups whose dot-prefix (e.g.
  // "docs.") is entirely absent from the static output. Groups partially
  // visible to the static parser are left alone so renames/removals propagate
  // immediately without requiring a server restart.
  //
  // The runtime manifest (cachedManifest / perRouterManifestMap) is updated
  // automatically: the virtual:rsc-router/routes-manifest module imports the
  // gen file, so when we write new content here, Vite's HMR invalidates the
  // virtual module and re-evaluates it on the next request.
  function supplementGenFilesWithRuntimeRoutes() {
    // Cache static parsing results to avoid redundant I/O + parsing per router.
    const parseCache = new Map<string, ReturnType<typeof buildCombinedRouteMapForRouterFile>>();
    const getParsed = (file: string) => {
      let cached = parseCache.get(file);
      if (!cached) {
        cached = buildCombinedRouteMapForRouterFile(file);
        parseCache.set(file, cached);
      }
      return cached;
    };

    for (const { routeManifest, routeSearchSchemas, sourceFile, factoryOnlyPrefixes } of perRouterManifests) {
      if (!sourceFile) continue;
      if (!factoryOnlyPrefixes || factoryOnlyPrefixes.size === 0) continue;

      const staticParsed = getParsed(sourceFile);

      // Merge: static routes (authoritative) + factory-only groups from runtime.
      const mergedRoutes: Record<string, string> = { ...staticParsed.routes };
      const mergedSearchSchemas: Record<string, Record<string, string>> = { ...staticParsed.searchSchemas };

      for (const [name, pattern] of Object.entries(routeManifest)) {
        const dotIdx = name.indexOf(".");
        if (dotIdx <= 0) continue;
        const prefix = name.substring(0, dotIdx + 1);
        if (factoryOnlyPrefixes.has(prefix)) {
          mergedRoutes[name] = pattern;
          // Also merge search schemas from factory-generated routes
          if (routeSearchSchemas?.[name]) {
            mergedSearchSchemas[name] = routeSearchSchemas[name];
          }
        }
      }

      const routerDir = dirname(sourceFile);
      const routerBasename = basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
      const outPath = join(routerDir, `${routerBasename}.named-routes.gen.ts`);
      const source = generateRouteTypesSource(
        mergedRoutes,
        Object.keys(mergedSearchSchemas).length > 0 ? mergedSearchSchemas : undefined,
      );
      const existing = existsSync(outPath) ? readFileSync(outPath, "utf-8") : null;
      if (existing !== source) {
        writeFileSync(outPath, source);
      }
    }
    // No manual manifest update needed: the virtual module imports the gen
    // file, so Vite's HMR automatically re-evaluates it with fresh data.
  }

  return {
    name: "@rangojs/router:discovery",

    config() {
      if (!opts?.enableBuildPrerender) return {};
      return {
        environments: {
          rsc: {
            build: {
              rollupOptions: {
                output: {
                  manualChunks(id: string) {
                    if (resolvedPrerenderModules?.has(id)) {
                      return "__prerender-handlers";
                    }
                    if (resolvedStaticModules?.has(id)) {
                      return "__static-handlers";
                    }
                  },
                },
              },
            },
          },
        },
      };
    },

    configResolved(config) {
      projectRoot = config.root;
      isBuildMode = config.command === "build";
      // Capture user's resolve aliases for the temp server
      userResolveAlias = config.resolve.alias;
      // Compile include/exclude patterns into a scan filter
      if (opts?.include || opts?.exclude) {
        scanFilter = createScanFilter(projectRoot, {
          include: opts.include,
          exclude: opts.exclude,
        });
      }
      // Generate combined named-routes.gen.ts from static source parsing.
      // Runs before the dev server starts so the gen file exists immediately for IDE.
      // In build mode, the runtime discovery in buildStart produces the definitive
      // named-routes.gen.ts (including dynamically generated routes).
      // preserveIfLarger prevents overwriting a previously generated complete
      // file with a partial one.
      if (opts?.staticRouteTypesGeneration !== false) {
        cachedRouterFiles = findRouterFiles(projectRoot, scanFilter);
        writeCombinedRouteTypes(projectRoot, cachedRouterFiles, { preserveIfLarger: true });
      }
      // Resolve prerenderHandlerModules and staticHandlerModules from the consolidated IDs plugin's API.
      if (opts?.enableBuildPrerender) {
        const idsPlugin = config.plugins.find(
          (p: any) => p.name === "@rangojs/router:expose-internal-ids",
        );
        resolvedPrerenderModules =
          (idsPlugin?.api as any)?.prerenderHandlerModules;
        resolvedStaticModules =
          (idsPlugin?.api as any)?.staticHandlerModules;
      }
    },

    // Dev mode: discover routers and populate manifest in memory.
    // Skipped in build mode (buildStart handles it).
    configureServer(server) {
      if (isBuildMode) return;
      // Skip if this is a temp server created by buildStart
      if ((globalThis as any).__rscRouterDiscoveryActive) return;
      devServer = server;

      // Discovery promise that the handler can await if requests arrive
      // before discovery completes
      let resolveDiscovery: () => void;
      const discoveryPromise = new Promise<void>((resolve) => {
        resolveDiscovery = resolve;
      });

      // Compute dev server origin from resolved URLs (preferred) or config port (fallback).
      // Called after discovery (or in the load hook) when the server may be listening.
      const getDevServerOrigin = () =>
        server.resolvedUrls?.local?.[0]?.replace(/\/$/, '')
        || `http://localhost:${server.config.server.port || 5173}`;

      // Shared temp server for Cloudflare dev (no module runner in workerd).
      // Used by both discover() (route type generation) and the prerender
      // middleware (on-demand prerender evaluation). Created lazily, closed on
      // server shutdown.
      let prerenderTempServer: any = null;
      let prerenderNodeRegistry: Map<string, any> | null = null;

      // Clean up the temporary server when the dev server shuts down
      server.httpServer?.on("close", () => {
        if (prerenderTempServer) {
          prerenderTempServer.close().catch(() => {});
          prerenderTempServer = null;
        }
      });

      async function getOrCreateTempServer(): Promise<any | null> {
        if (prerenderNodeRegistry) {
          return (prerenderTempServer.environments as any)?.rsc ?? null;
        }
        try {
          const { default: rsc } = await import("@vitejs/plugin-rsc");
          prerenderTempServer = await createViteServer({
            root: projectRoot,
            configFile: false,
            server: { middlewareMode: true },
            appType: "custom",
            logLevel: "silent",
            cacheDir: "node_modules/.vite_prerender",
            resolve: { alias: userResolveAlias },
            esbuild: { jsx: "automatic", jsxImportSource: "react" },
            plugins: [
              rsc({ entries: { client: "virtual:entry-client", ssr: "virtual:entry-ssr", rsc: entryPath } }),
              createVersionPlugin(),
              createVirtualStubPlugin(),
              // Dev prerender must use dev-mode IDs (path-based) to match the
              // workerd runtime. forceBuild would produce hashed IDs causing
              // handle data key mismatches when replayed into the runtime store.
              exposeInternalIds(),
              exposeRouterId(),
            ],
          });

          const tempRscEnv = (prerenderTempServer.environments as any)?.rsc;
          if (tempRscEnv?.runner) {
            await tempRscEnv.runner.import(entryPath);
            const serverMod = await tempRscEnv.runner.import("@rangojs/router/server");
            prerenderNodeRegistry = serverMod.RouterRegistry;
            return tempRscEnv;
          }
        } catch (err: any) {
          console.warn(`[rsc-router] Failed to create temp runner: ${err.message}`);
        }
        return null;
      }

      const discover = async () => {
        const rscEnv = (server.environments as any)?.rsc;
        if (!rscEnv?.runner) {
          // Cloudflare dev: no module runner available (workerd-based RSC env).
          // Set devServerOrigin so the virtual module can inject __PRERENDER_DEV_URL
          // for on-demand prerender via the /__rsc_prerender endpoint.
          devServerOrigin = getDevServerOrigin();

          // Create a temp Node.js server to run runtime discovery and generate
          // named route types (static parser can't resolve factory calls).
          try {
            const tempRscEnv = await getOrCreateTempServer();
            if (tempRscEnv) {
              await discoverRouters(tempRscEnv);
              writeRouteTypesFiles();
            }
          } catch (err: any) {
            console.warn(
              `[rsc-router] Cloudflare dev discovery failed: ${err.message}\n${err.stack}`
            );
          }

          resolveDiscovery!();
          return;
        }

        try {
          // Set the readiness gate BEFORE discovery so early requests
          // block until manifest is populated
          const serverMod = await rscEnv.runner.import("@rangojs/router/server");
          if (serverMod?.setManifestReadyPromise) {
            serverMod.setManifestReadyPromise(discoveryPromise);
          }

          const serverModAfterDiscovery = await discoverRouters(rscEnv);

          // Save registry for the /__rsc_prerender endpoint (avoids creating a temp server)
          mainRegistry = serverModAfterDiscovery?.RouterRegistry ?? null;

          // Store server origin for dev prerender endpoint (virtual module injection)
          devServerOrigin = getDevServerOrigin();

          // Update named-routes.gen.ts from runtime discovery.
          // The runtime manifest is the source of truth: it evaluates dynamic
          // routes (e.g. Array.from loops) that the static parser cannot see.
          // writeRouteTypesFiles() only writes when content changes, so this
          // won't cause unnecessary HMR triggers.
          writeRouteTypesFiles();

          // Populate the route map in the RSC env
          if (mergedRouteManifest && serverMod?.setCachedManifest) {
            serverMod.setCachedManifest(mergedRouteManifest);
          }
          if (mergedPrecomputedEntries && mergedPrecomputedEntries.length > 0 && serverMod?.setPrecomputedEntries) {
            serverMod.setPrecomputedEntries(mergedPrecomputedEntries);
          }
          if (mergedRouteTrie && serverMod?.setRouteTrie) {
            serverMod.setRouteTrie(mergedRouteTrie);
          }
          // Populate per-router isolated data eagerly in dev (HMR).
          // In production builds, per-router data is loaded lazily via import().
          if (serverMod?.setRouterManifest) {
            for (const [routerId, manifest] of perRouterManifestDataMap) {
              serverMod.setRouterManifest(routerId, manifest);
            }
          }
          if (serverMod?.setRouterTrie) {
            for (const [routerId, trie] of perRouterTrieMap) {
              serverMod.setRouterTrie(routerId, trie);
            }
          }
          if (serverMod?.setRouterPrecomputedEntries) {
            for (const [routerId, entries] of perRouterPrecomputedMap) {
              serverMod.setRouterPrecomputedEntries(routerId, entries);
            }
          }
        } catch (err: any) {
          console.warn(
            `[rsc-router] Router discovery failed: ${err.message}\n${err.stack}`
          );
        } finally {
          resolveDiscovery!();
        }
      };

      // Schedule after all plugins have finished configureServer.
      // Store the promise so the virtual module's load hook can await it.
      discoveryDone = new Promise<void>((resolve) => {
        setTimeout(() => discover().then(resolve, resolve), 0);
      });

      // Dev-mode on-demand prerender endpoint.
      // When workerd hits a prerender route, it fetches this endpoint instead of
      // trying to run node:fs-dependent handlers in the Cloudflare environment.
      //
      // Node.js preset: uses the main server's RSC environment directly (router
      // instances are already discovered and have matchForPrerender).
      // Cloudflare preset: lazily creates a Node.js temp server because the main
      // RSC environment uses workerd where node:fs can't access the host filesystem.

      // Registry from the main server's RSC environment (populated by discoverRouters)
      let mainRegistry: Map<string, any> | null = null;

      server.middlewares.use("/__rsc_prerender", async (req: any, res: any) => {
        if (discoveryDone) await discoveryDone;

        const url = new URL(req.url || "/", "http://localhost");
        const pathname = url.searchParams.get("pathname");
        if (!pathname) {
          res.statusCode = 400;
          res.end("Missing pathname");
          return;
        }

        // Prefer the main server's registry (Node.js preset: module runner available).
        // Fall back to a temp server for Cloudflare where the main RSC env uses workerd.
        let registry = mainRegistry;

        if (!registry) {
          // No main registry: the RSC env has no module runner (Cloudflare dev).
          // Lazily create a Node.js temp server for prerender evaluation.
          if (!prerenderNodeRegistry) {
            await getOrCreateTempServer();
          }
          registry = prerenderNodeRegistry;
        }

        if (!registry || registry.size === 0) {
          res.statusCode = 503;
          res.end("Prerender runner not available");
          return;
        }

        const wantIntercept = url.searchParams.get("intercept") === "1";

        for (const [, routerInstance] of registry) {
          if (!routerInstance.matchForPrerender) continue;
          try {
            const result = await routerInstance.matchForPrerender(pathname, {});
            if (!result) continue;
            res.setHeader("content-type", "application/json");
            let payload: Record<string, unknown>;
            if (wantIntercept && result.interceptSegments?.length) {
              payload = {
                segments: [...result.segments, ...result.interceptSegments],
                handles: { ...result.handles, ...(result.interceptHandles || {}) },
              };
            } else {
              payload = { segments: result.segments, handles: result.handles };
            }
            res.end(JSON.stringify(payload));
            return;
          } catch (err: any) {
            console.warn(`[rsc-router] Dev prerender failed for ${pathname}: ${err.message}`);
          }
        }

        res.statusCode = 404;
        res.end("No prerender match");
      });

      // Watch url module and router files for changes and regenerate named-routes.gen.ts.
      // Process files containing urls( or createRouter( to update the combined route map.
      if (opts?.staticRouteTypesGeneration !== false) {
        server.watcher.on("change", (filePath) => {
          if (filePath.endsWith(".gen.ts")) return;
          if (
            !filePath.endsWith(".ts") &&
            !filePath.endsWith(".tsx") &&
            !filePath.endsWith(".js") &&
            !filePath.endsWith(".jsx")
          ) return;
          // Apply scan filter as early-exit before reading file
          if (scanFilter && !scanFilter(filePath)) return;
          try {
            const source = readFileSync(filePath, "utf-8");
            const trimmed = source.trimStart();
            if (trimmed.startsWith('"use client"') || trimmed.startsWith("'use client'")) return;
            const hasUrls = source.includes("urls(");
            const hasCreateRouter = /\bcreateRouter\s*[<(]/.test(source);
            if (!hasUrls && !hasCreateRouter) return;
            // Invalidate cache when a router file changes (new router added/removed)
            if (hasCreateRouter) {
              cachedRouterFiles = undefined;
            }
            writeCombinedRouteTypes(projectRoot, cachedRouterFiles);
            // Static parsing can't resolve factory calls (e.g. createDocsPatterns()).
            // If runtime discovery already ran, supplement the static output with
            // factory-generated routes that the parser missed. Static routes take
            // precedence (reflecting renames/additions/removals in source), and
            // runtime-only routes (from factories) fill the gaps.
            // Also update the runtime cachedManifest so reverse() reflects the
            // same route changes (adds, removes, renames) seen in the gen file.
            if (perRouterManifests.length > 0) {
              supplementGenFilesWithRuntimeRoutes();
            }
          } catch {
            // Ignore read errors for deleted/moved files
          }
        });

        // Regenerate gen files when they are deleted (e.g. manual cleanup).
        server.watcher.on("unlink", (filePath) => {
          if (!filePath.endsWith(".gen.ts")) return;
          if (!filePath.includes("named-routes.gen.ts") && !filePath.includes("urls.gen.ts")) return;
          if (perRouterManifests.length > 0) {
            writeRouteTypesFiles();
          } else {
            writeCombinedRouteTypes(projectRoot, cachedRouterFiles);
          }
        });
      }
    },

    // Build mode: create a temporary Vite dev server to access the RSC
    // environment's module runner, then discover routers and generate manifests.
    // The manifest data is stored for the virtual module's load hook.
    async buildStart() {
      if (!isBuildMode) return;
      // Only run once across environment builds
      if (mergedRouteManifest !== null) return;

      let tempServer: any = null;
      // Signal to user-space code (e.g. reverse.ts) that build-time discovery
      // is active. Uses globalThis because the temp server's module runner
      // creates a separate module context — there is no shared import path
      // between the vite plugin and user code loaded via runner.import().
      (globalThis as any).__rscRouterDiscoveryActive = true;
      try {
        // Create a minimal Vite server with just the RSC plugin.
        // We bypass the user's config file because:
        // - Custom environments (e.g., CloudflareDevEnvironment) may not expose
        //   a module runner compatible with runner.import()
        // - The temp server only needs RSC conditions to import the router
        const { default: rsc } = await import("@vitejs/plugin-rsc");
        tempServer = await createViteServer({
          root: projectRoot,
          configFile: false,
          server: { middlewareMode: true },
          appType: "custom",
          logLevel: "silent",
          // Use the resolved aliases from the real config (includes user's path aliases
          // like @/ -> src/ AND package aliases from rsc-router)
          resolve: { alias: userResolveAlias },
          // Enable automatic JSX runtime so .tsx files don't need `import React`.
          // Without this, esbuild defaults to classic mode (React.createElement)
          // which fails when lazy host-router handlers load sub-app modules with JSX.
          esbuild: { jsx: "automatic", jsxImportSource: "react" },
          plugins: [
            rsc({ entries: { client: "virtual:entry-client", ssr: "virtual:entry-ssr", rsc: entryPath } }),
            hashClientRefs(projectRoot),
            createVersionPlugin(),
            // Stub virtual modules that the RSC entry may import
            // (e.g., virtual:rsc-router/routes-manifest, virtual:rsc-router/loader-manifest)
            createVirtualStubPlugin(),
            // Inject handle + router IDs so prerender-collected handle data uses
            // the same hashed keys as the production client/SSR bundles, and
            // build-time router IDs match runtime IDs across environments.
            exposeInternalIds({ forceBuild: true }),
            exposeRouterId(),
          ],
        });

        const rscEnv = (tempServer.environments as any)?.rsc;
        if (!rscEnv?.runner) {
          console.warn(
            "[rsc-router] RSC environment runner not available during build, skipping manifest generation"
          );
          return;
        }

        // Point resolvedStaticModules at the temp server's expose-internal-ids
        // plugin so that discoverRouters() can access the static handler module
        // map after the temp server's transforms populate it.
        const tempIdsPlugin = (tempServer as any).config?.plugins?.find(
          (p: any) => p.name === "@rangojs/router:expose-internal-ids",
        );
        if (tempIdsPlugin?.api?.staticHandlerModules) {
          resolvedStaticModules = tempIdsPlugin.api.staticHandlerModules;
        }

        await discoverRouters(rscEnv);
        // Update named-routes.gen.ts from runtime discovery.
        // The runtime manifest includes dynamically generated routes
        // that the static parser cannot extract from source code.
        writeRouteTypesFiles();
      } catch (err: any) {
        // Extract the user source file from the stack trace (skip internal frames)
        const sourceFile = err.stack
          ?.split("\n")
          .find((line: string) => line.includes(projectRoot) && !line.includes("node_modules"))
          ?.match(/\(([^)]+)\)/)?.[1];
        // Extract the route name from "Unknown route: <name>" errors
        const routeName = err.message?.match(/Unknown route: (.+)/)?.[1];
        const details = [
          routeName ? `  Route name: ${routeName}` : null,
          sourceFile ? `  File: ${sourceFile}` : null,
          err.stack ? `  Stack:\n${err.stack}` : null,
        ].filter(Boolean).join("\n");
        throw new Error(
          `[rsc-router] Build-time router discovery failed:\n${details}`
        );
      } finally {
        delete (globalThis as any).__rscRouterDiscoveryActive;
        if (tempServer) {
          await tempServer.close();
        }
      }
    },

    // Virtual module: provides the pre-generated route manifest as a JS module
    // that calls setCachedManifest() at import time.
    resolveId(id) {
      if (id === VIRTUAL_ROUTES_MANIFEST_ID) {
        return "\0" + VIRTUAL_ROUTES_MANIFEST_ID;
      }
      // Per-router virtual modules: virtual:rsc-router/routes-manifest/<routerId>
      if (id.startsWith(VIRTUAL_ROUTES_MANIFEST_ID + "/")) {
        return "\0" + id;
      }
      // virtual:rsc-router/prerender-paths removed: prerender data is served through the worker
      return null;
    },

    async load(id) {
      if (id === "\0" + VIRTUAL_ROUTES_MANIFEST_ID) {
        // In dev mode, wait for discovery to complete before emitting module content.
        // This is critical for Cloudflare dev where the worker runs in a separate
        // Miniflare process and can only receive manifest data via the virtual module.
        if (discoveryDone) {
          await discoveryDone;
        }
        const hasManifest = mergedRouteManifest && Object.keys(mergedRouteManifest).length > 0;
        if (hasManifest) {
          // Build gen file import statements for each router with a sourceFile.
          // This creates a dependency in Vite's module graph: when the gen file
          // changes (e.g. after HMR route edits), Vite invalidates this virtual
          // module and re-evaluates it on the next request, calling
          // setCachedManifest() with fresh data. No manual sync needed.
          const genFileImports: string[] = [];
          const genFileVars: string[] = [];
          const routersWithoutGenFile: Array<{ id: string; manifest: Record<string, string> }> = [];
          let varIdx = 0;

          for (const entry of perRouterManifests) {
            if (entry.sourceFile) {
              const routerDir = dirname(entry.sourceFile);
              const routerBasename = basename(entry.sourceFile).replace(/\.(tsx?|jsx?)$/, "");
              const genPath = join(routerDir, `${routerBasename}.named-routes.gen.js`);
              const varName = `_r${varIdx++}`;
              genFileImports.push(`import { NamedRoutes as ${varName} } from ${JSON.stringify(genPath)};`);
              genFileVars.push(varName);
            } else {
              // Routers without sourceFile: inline their manifest data directly
              routersWithoutGenFile.push({ id: entry.id, manifest: entry.routeManifest });
            }
          }

          const lines = [
            `import { setCachedManifest, setPrecomputedEntries, setRouteTrie, setRouterManifest, registerRouterManifestLoader } from "@rangojs/router/server";`,
            ...genFileImports,
          ];

          // Flatten NamedRoutes entries: search schema objects -> plain string paths
          if (genFileVars.length > 0) {
            lines.push(`function __flat(r) { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === "string" ? v : v.path; return o; }`);
          }

          // Build the merged manifest from gen file imports + inlined data
          if (genFileVars.length === 1 && routersWithoutGenFile.length === 0) {
            lines.push(`setCachedManifest(__flat(${genFileVars[0]}));`);
          } else {
            const parts: string[] = [];
            for (const v of genFileVars) parts.push(`...__flat(${v})`);
            for (const { manifest } of routersWithoutGenFile) parts.push(`...${jsonParseExpression(manifest)}`);
            lines.push(`setCachedManifest({ ${parts.join(", ")} });`);
          }

          // Set per-router manifests
          let genVarIdx = 0;
          for (const entry of perRouterManifests) {
            if (entry.sourceFile) {
              const varName = genFileVars[genVarIdx++];
              lines.push(`setRouterManifest(${JSON.stringify(entry.id)}, __flat(${varName}));`);
            } else {
              lines.push(`setRouterManifest(${JSON.stringify(entry.id)}, ${jsonParseExpression(entry.routeManifest)});`);
            }
          }

          if (mergedPrecomputedEntries && mergedPrecomputedEntries.length > 0) {
            lines.push(`setPrecomputedEntries(${jsonParseExpression(mergedPrecomputedEntries)});`);
          }
          if (mergedRouteTrie) {
            lines.push(`setRouteTrie(${jsonParseExpression(mergedRouteTrie)});`);
          }
          // Register lazy loaders for per-router manifest modules.
          // Each import() uses a static string literal so Rollup creates separate chunks.
          for (const routerId of perRouterManifestDataMap.keys()) {
            lines.push(
              `registerRouterManifestLoader(${JSON.stringify(routerId)}, () => import(${JSON.stringify(VIRTUAL_ROUTES_MANIFEST_ID + "/" + routerId)}));`,
            );
          }
          if (!isBuildMode && devServerOrigin) {
            lines.push(`globalThis.__PRERENDER_DEV_URL = ${JSON.stringify(devServerOrigin)};`);
          }
          return lines.join("\n");
        }
        // No manifest: either discovery hasn't completed or no runner (Cloudflare dev).
        // Still inject __PRERENDER_DEV_URL so the prerender store can fetch on-demand.
        // Re-resolve origin now since the server is listening by module load time.
        if (!isBuildMode) {
          const origin = devServerOrigin
            || devServer?.resolvedUrls?.local?.[0]?.replace(/\/$/, '')
            || (devServer && `http://localhost:${devServer.config.server.port || 5173}`);
          if (origin) {
            devServerOrigin = origin;
            return `globalThis.__PRERENDER_DEV_URL = ${JSON.stringify(origin)};`;
          }
        }
        return `// Route manifest will be populated at runtime`;
      }
      // Per-router virtual modules: pure data exports (no side effects).
      // ensureRouterManifest() imports the module and stores the data.
      const perRouterPrefix = "\0" + VIRTUAL_ROUTES_MANIFEST_ID + "/";
      if (id.startsWith(perRouterPrefix)) {
        if (discoveryDone) {
          await discoveryDone;
        }
        const routerId = id.slice(perRouterPrefix.length);
        // Find the per-router entry to get the gen file path
        const routerEntry = perRouterManifests.find(e => e.id === routerId);
        const trie = perRouterTrieMap.get(routerId);
        const entries = perRouterPrecomputedMap.get(routerId);
        const lines: string[] = [];

        if (routerEntry?.sourceFile) {
          // Import manifest from the gen file so HMR auto-propagates
          const routerDir = dirname(routerEntry.sourceFile);
          const routerBasename = basename(routerEntry.sourceFile).replace(/\.(tsx?|jsx?)$/, "");
          const genPath = join(routerDir, `${routerBasename}.named-routes.gen.js`);
          lines.push(`import { NamedRoutes as _r } from ${JSON.stringify(genPath)};`);
          lines.push(`function __flat(r) { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === "string" ? v : v.path; return o; }`);
          lines.push(`export const manifest = __flat(_r);`);
        } else {
          const manifest = perRouterManifestDataMap.get(routerId);
          if (manifest) {
            lines.push(`export const manifest = ${jsonParseExpression(manifest)};`);
          }
        }
        if (trie) {
          lines.push(`export const trie = ${jsonParseExpression(trie)};`);
        }
        if (entries && entries.length > 0) {
          lines.push(`export const precomputedEntries = ${jsonParseExpression(entries)};`);
        }
        return lines.join("\n") || "// empty router manifest";
      }
      // virtual:rsc-router/prerender-paths load handler removed
      return null;
    },

    // Record handler chunk metadata and RSC entry filename during RSC build.
    // Used by closeBundle for handler code eviction and prerender data injection.
    generateBundle(_options: any, bundle: any) {
      if (this.environment?.name !== "rsc") return;

      // Record RSC entry chunk filename for closeBundle injection
      for (const [fileName, chunk] of Object.entries(bundle) as [string, any][]) {
        if (chunk.type === "chunk" && chunk.isEntry) {
          rscEntryFileName = fileName;
          break;
        }
      }

      if (!resolvedPrerenderModules?.size && !resolvedStaticModules?.size) return;

      for (const [fileName, chunk] of Object.entries(bundle) as [string, any][]) {
        if (chunk.type !== "chunk") continue;

        // Prerender handlers chunk
        if (fileName.includes("__prerender-handlers") && resolvedPrerenderModules?.size) {
          const handlers = extractHandlerExportsFromChunk(
            chunk.code, resolvedPrerenderModules, "Prerender", true,
          );
          if (handlers.length > 0) {
            handlerChunkInfo = { fileName, exports: handlers };
          }
        }

        // Static handlers chunk
        if (fileName.includes("__static-handlers") && resolvedStaticModules?.size) {
          const handlers = extractHandlerExportsFromChunk(
            chunk.code, resolvedStaticModules, "Static", false,
          );
          if (handlers.length > 0) {
            staticHandlerChunkInfo = { fileName, exports: handlers };
          }
        }
      }

    },

    // Build-time pre-rendering: evict handler code and inject collected prerender data.
    // Collection now happens in-process during discoverRouters() via RSC runner.
    // closeBundle only needs to evict handlers and inject the in-memory data.
    closeBundle: {
      order: "post" as const,
      sequential: true,
      async handler() {
        if (!isBuildMode) return;
        const hasPrerenderData = prerenderCollectedData && Object.keys(prerenderCollectedData).length > 0;
        const hasStaticData = staticCollectedData && Object.keys(staticCollectedData).length > 0;
        if (!hasPrerenderData && !hasStaticData) return;

        // Find RSC entry (recorded in generateBundle, fallback to dist/rsc/index.js)
        const rscEntryPath = resolve(projectRoot, "dist/rsc", rscEntryFileName ?? "index.js");

        // 1. Evict handler code from __prerender-handlers and __static-handlers chunks.
        // handlerChunkInfo/staticHandlerChunkInfo are populated by generateBundle
        // after the production RSC build. In Vite 6 multi-environment builds, the
        // RSC build runs twice (analysis + production). Chunk info is only available
        // after the production pass, so we run eviction whenever it becomes available.
        const evictionTargets: Array<{
          info: typeof handlerChunkInfo;
          fnName: string;
          brand: string;
          label: string;
        }> = [
          { info: handlerChunkInfo, fnName: "Prerender", brand: "prerenderHandler", label: "handler code from RSC bundle" },
          { info: staticHandlerChunkInfo, fnName: "Static", brand: "staticHandler", label: "static handler code" },
        ];

        for (const target of evictionTargets) {
          if (!target.info) continue;
          const chunkPath = resolve(projectRoot, "dist/rsc", target.info.fileName);
          try {
            const code = readFileSync(chunkPath, "utf-8");
            const result = evictHandlerCode(code, target.info.exports, target.fnName, target.brand);
            if (result) {
              writeFileSync(chunkPath, result.code);
              const savedKB = (result.savedBytes / 1024).toFixed(1);
              console.log(
                `[rsc-router] Evicted ${target.label} (${savedKB} KB saved): ${target.info.fileName}`,
              );
            }
          } catch (replaceErr: any) {
            console.warn(
              `[rsc-router] Failed to evict ${target.label}: ${replaceErr.message}`,
            );
          }
        }
        handlerChunkInfo = null;
        staticHandlerChunkInfo = null;

        // 2. Write prerender data as separate importable asset modules
        // and inject a manifest import into the RSC entry.
        if (hasPrerenderData && existsSync(rscEntryPath)) {
          const rscCode = readFileSync(rscEntryPath, "utf-8");
          if (!rscCode.includes("__PRERENDER_MANIFEST")) {
            try {
              const assetsDir = resolve(projectRoot, "dist/rsc/assets");
              mkdirSync(assetsDir, { recursive: true });

              const manifestEntries: string[] = [];
              let totalBytes = 0;

              for (const [key, entry] of Object.entries(prerenderCollectedData!)) {
                const entryJson = JSON.stringify(entry);
                const contentHash = createHash("sha256").update(entryJson).digest("hex").slice(0, 8);
                const assetFileName = `__pr-${contentHash}.js`;
                const assetPath = resolve(assetsDir, assetFileName);
                const assetCode = `export default ${entryJson};\n`;
                writeFileSync(assetPath, assetCode);
                totalBytes += Buffer.byteLength(assetCode);
                manifestEntries.push(`${JSON.stringify(key)}:()=>import("./assets/${assetFileName}")`);
              }

              const manifestCode = `const m={${manifestEntries.join(",")}};export default m;\n`;
              const manifestPath = resolve(projectRoot, "dist/rsc/__prerender-manifest.js");
              writeFileSync(manifestPath, manifestCode);
              totalBytes += Buffer.byteLength(manifestCode);

              const injection = `import __pm from "./__prerender-manifest.js";\nglobalThis.__PRERENDER_MANIFEST = __pm;\n`;
              writeFileSync(rscEntryPath, injection + rscCode);

              const totalKB = (totalBytes / 1024).toFixed(1);
              console.log(
                `[rsc-router] Wrote prerender assets (${totalKB} KB total, ${Object.keys(prerenderCollectedData!).length} entries)`,
              );
            } catch (err: any) {
              throw new Error(`[rsc-router] Failed to write prerender assets: ${err.message}`);
            }
          }
        }

        // 3b. Write static handler data as separate importable asset modules
        // and inject a __STATIC_MANIFEST import into the RSC entry.
        if (hasStaticData && existsSync(rscEntryPath)) {
          const rscCode = readFileSync(rscEntryPath, "utf-8");
          if (!rscCode.includes("__STATIC_MANIFEST")) {
            try {
              const assetsDir = resolve(projectRoot, "dist/rsc/assets");
              mkdirSync(assetsDir, { recursive: true });

              const manifestEntries: string[] = [];
              let totalBytes = 0;

              for (const [handlerId, { encoded, handles }] of Object.entries(staticCollectedData!)) {
                const contentHash = createHash("sha256").update(encoded).digest("hex").slice(0, 8);
                const assetFileName = `__st-${contentHash}.js`;
                const assetPath = resolve(assetsDir, assetFileName);
                // Store both the Flight payload and handle data
                const hasHandles = Object.keys(handles).length > 0;
                const exportValue = hasHandles
                  ? JSON.stringify({ encoded, handles })
                  : JSON.stringify(encoded);
                const assetCode = `export default ${exportValue};\n`;
                writeFileSync(assetPath, assetCode);
                totalBytes += Buffer.byteLength(assetCode);
                manifestEntries.push(`${JSON.stringify(handlerId)}:()=>import("./assets/${assetFileName}")`);
              }

              // Set the global inside the manifest module so it is assigned
              // during module evaluation (before dependent modules like
              // segment-resolution.ts run their top-level initializers).
              const manifestCode = `const m={${manifestEntries.join(",")}};globalThis.__STATIC_MANIFEST=m;export default m;\n`;
              const manifestPath = resolve(projectRoot, "dist/rsc/__static-manifest.js");
              writeFileSync(manifestPath, manifestCode);
              totalBytes += Buffer.byteLength(manifestCode);

              // The import ensures the manifest module is evaluated early.
              // The global is already set inside the module itself.
              const injection = `import "./__static-manifest.js";\n`;
              writeFileSync(rscEntryPath, injection + rscCode);

              const totalKB = (totalBytes / 1024).toFixed(1);
              console.log(
                `[rsc-router] Wrote static assets (${totalKB} KB total, ${Object.keys(staticCollectedData!).length} entries)`,
              );
            } catch (err: any) {
              throw new Error(`[rsc-router] Failed to write static assets: ${err.message}`);
            }
          }
        }
      },
    },
  };
}

/**
 * Strip JSONC comments (single-line // and block comments) from a string
 * without corrupting URLs or other values inside quoted strings.
 * Uses a simple state machine to track whether we are inside a JSON string.
 */
function stripJsonComments(input: string): string {
  let result = "";
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    // Quoted string: copy verbatim, respecting backslash escapes
    if (ch === '"') {
      result += ch;
      i++;
      while (i < len) {
        const sc = input[i];
        result += sc;
        i++;
        if (sc === "\\") {
          // Copy the escaped character as-is
          if (i < len) {
            result += input[i];
            i++;
          }
        } else if (sc === '"') {
          break;
        }
      }
      continue;
    }

    // Single-line comment: skip to end of line
    if (ch === "/" && i + 1 < len && input[i + 1] === "/") {
      i += 2;
      while (i < len && input[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Block comment: skip to closing */
    if (ch === "/" && i + 1 < len && input[i + 1] === "*") {
      i += 2;
      while (i < len) {
        if (input[i] === "*" && i + 1 < len && input[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

const VIRTUAL_ROUTES_MANIFEST_ID = "virtual:rsc-router/routes-manifest";
// VIRTUAL_PRERENDER_PATHS_ID removed: prerender data is served through the worker

/**
 * Resolve the entry path for build-time router discovery.
 * - Node preset: uses the `router` option (may be undefined if auto-discovery failed).
 * - Cloudflare preset: reads the `main` field from wrangler.json.
 */
function resolveDiscoveryEntryPath(options: RangoOptions, routerPath?: string): string | undefined {
  if (options.preset === "cloudflare") {
    // Auto-detect from wrangler.json
    const wranglerPaths = ["wrangler.json", "wrangler.jsonc"];
    for (const filename of wranglerPaths) {
      if (existsSync(filename)) {
        try {
          const raw = readFileSync(filename, "utf-8");
          // Strip JSONC comments (// and /* */) without corrupting URLs in strings
          const cleaned = stripJsonComments(raw);
          const config = JSON.parse(cleaned);
          if (config.main) {
            return config.main;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
    return undefined;
  }
  // Node preset: use resolved routerPath (may be auto-discovered or explicit)
  return routerPath;
}

/**
 * Stub plugin for virtual modules in the temp discovery server.
 * The RSC entry may import virtual modules (routes-manifest, loader-manifest)
 * that aren't available in the temp server. The RSC plugin also requires
 * client/ssr entries which don't need real content for discovery.
 */
function createVirtualStubPlugin(): Plugin {
  const STUB_PREFIXES = [
    "virtual:rsc-router/",
    "virtual:entry-",
    "virtual:vite-rsc/",
  ];
  return {
    name: "@rangojs/router:virtual-stubs",
    resolveId(id) {
      if (STUB_PREFIXES.some((p) => id.startsWith(p))) {
        return "\0stub:" + id;
      }
      return null;
    },
    load(id) {
      if (id.startsWith("\0stub:")) {
        return "export default {}";
      }
      return null;
    },
  };
}

/**
 * Wrap a value as `JSON.parse('...')` instead of a JS object literal.
 * V8's JSON parser is significantly faster than its full JS parser for large
 * objects, so this improves startup time for big route manifests.
 */
function jsonParseExpression(value: unknown): string {
  const json = JSON.stringify(value);
  const escaped = json.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `JSON.parse('${escaped}')`;
}

/**
 * Plugin that auto-injects VERSION and routes-manifest into custom entry.rsc files.
 * If a custom entry.rsc file uses createRSCHandler but doesn't pass version,
 * this transform adds the import and property automatically.
 * Also ensures the routes-manifest virtual module is always imported.
 * @internal
 */
function createVersionInjectorPlugin(rscEntryPath: string): Plugin {
  let projectRoot = "";
  let resolvedEntryPath = "";

  return {
    name: "@rangojs/router:version-injector",
    enforce: "pre",

    configResolved(config) {
      projectRoot = config.root;
      resolvedEntryPath = resolve(projectRoot, rscEntryPath);
    },

    transform(code, id) {
      // Only transform the RSC entry file
      const normalizedId = Vite.normalizePath(id);
      const normalizedEntry = Vite.normalizePath(resolvedEntryPath);

      if (normalizedId !== normalizedEntry) {
        return null;
      }

      // Prepend imports at the top of the file. ES imports are hoisted
      // by the module system, so source position is irrelevant.
      const prepend: string[] = [];
      let newCode = code;

      if (!code.includes("virtual:rsc-router/routes-manifest")) {
        prepend.push(`import "virtual:rsc-router/routes-manifest";`);
      }

      // Auto-inject VERSION if file uses createRSCHandler without version
      const needsVersion =
        code.includes("createRSCHandler") &&
        !code.includes("@rangojs/router:version") &&
        /createRSCHandler\s*\(\s*\{/.test(code);

      if (needsVersion) {
        prepend.push(`import { VERSION } from "@rangojs/router:version";`);
        newCode = newCode.replace(
          /createRSCHandler\s*\(\s*\{/,
          "createRSCHandler({\n  version: VERSION,"
        );
      }

      if (prepend.length === 0 && newCode === code) return null;

      newCode = prepend.join("\n") + (prepend.length > 0 ? "\n" : "") + newCode;

      return {
        code: newCode,
        map: null,
      };
    },
  };
}

const _require = createRequire(import.meta.url);
const _rangoVersion: string = _require("../../package.json").version;

let _bannerPrinted = false;

function printBanner(
  mode: "dev" | "build" | "preview",
  preset: string,
  version: string
): void {
  if (_bannerPrinted) return;
  _bannerPrinted = true;

  // ANSI codes
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";

  const banner = `
${dim}  ✦        ✦          ✧.           .          .${reset}
${dim} ╱${reset}    ${bold}╔═╗${reset}${dim}      *      ╱                   ✦             *${reset}
${dim}      ${reset}${bold}║ ║${reset} ${bold}╔═╗${reset}${dim}                    *                ✧.   ╱${reset}
${dim}   ${reset}${bold}╔╗ ║ ║ ║ ║${reset}${dim}                          *               ╱${reset}
${dim}   ${reset}${bold}║║ ║ ║ ║ ║  ╦═╗╔═╗╔╗╔╔═╗╔═╗${reset}${dim}             ✧              ✦${reset}
${dim}  ${reset}${bold}═╣║ ║ ╠═╝ ║  ╠╦╝╠═╣║║║║ ╦║ ║${reset}${dim}        *           ✧${reset}
${dim}   ${reset}${bold}║╚═╝ ╔═══╝  ╩╚═╩ ╩╝╚╝╚═╝╚═╝${reset}${dim}            ✦          .      *${reset}
${dim}   ${reset}${bold}╚══╗ ║${reset}${dim} *      RSC Wrangler         ✧                ✦${reset}
${dim}  *   ${reset}${bold}║ ╠═${reset}${dim}                         *            ✧.    ╱${reset}
${bold}══════╝ ╚═════════╩═══${reset}${dim}                  ✦            *${reset}

   v${version} · ${preset} · ${mode}
`;

  console.log(banner);
}

/**
 * Vite plugin for @rangojs/router.
 *
 * Includes @vitejs/plugin-rsc and all necessary transforms for the router
 * to function correctly with React Server Components.
 *
 * @example Node.js (default)
 * ```ts
 * export default defineConfig({
 *   plugins: [react(), rango({ router: './src/router.tsx' })],
 * });
 * ```
 *
 * @example Cloudflare Workers
 * ```ts
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     rango({ preset: 'cloudflare' }),
 *     cloudflare({ viteEnvironment: { name: 'rsc' } }),
 *   ],
 * });
 * ```
 */
export async function rango(
  options?: RangoOptions
): Promise<PluginOption[]> {
  const resolvedOptions: RangoOptions = options ?? { preset: "node" };
  const preset = resolvedOptions.preset ?? "node";
  const showBanner = resolvedOptions.banner ?? true;

  const plugins: PluginOption[] = [];

  // Get package resolution info (workspace vs npm install)
  const rangoAliases = getPackageAliases();
  const excludeDeps = getExcludeDeps();

  // Track RSC entry path for version injection
  let rscEntryPath: string | null = null;

  // Resolved router path (node preset only, may be auto-discovered)
  let routerPath: string | undefined;

  // Build-time prerendering is enabled for both presets.
  // Collection runs in-process via the RSC dev environment runner during discoverRouters().
  const prerenderEnabled = true;

  if (preset === "cloudflare") {
    // Cloudflare preset: configure entries for cloudflare worker setup
    // Router is not needed here - worker.rsc.tsx imports it directly

    // Dynamically import @vitejs/plugin-rsc
    const { default: rsc } = await import("@vitejs/plugin-rsc");

    // Only client and ssr entries - rsc entry is handled by cloudflare plugin
    // Always use virtual modules for cloudflare preset
    const finalEntries: { client: string; ssr: string } = {
      client: VIRTUAL_IDS.browser,
      ssr: VIRTUAL_IDS.ssr,
    };

    plugins.push({
      name: "@rangojs/router:cloudflare-integration",
      enforce: "pre",

      config() {
        // Configure environments for cloudflare deployment
        return {
          // Exclude rsc-router modules from optimization to prevent module duplication
          // This ensures the same Context instance is used by both browser entry and RSC proxy modules
          optimizeDeps: {
            exclude: excludeDeps,
            esbuildOptions: sharedEsbuildOptions,
          },
          resolve: {
            alias: rangoAliases,
          },
          build: {
            rollupOptions: { onwarn },
          },
          environments: {
            client: {
              build: {
                rollupOptions: {
                  output: {
                    manualChunks: getManualChunks,
                  },
                },
              },
              // Pre-bundle rsc-html-stream to prevent discovery during first request
              // Exclude rsc-router modules to ensure same Context instance
              optimizeDeps: {
                include: ["rsc-html-stream/client"],
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
              },
            },
            ssr: {
              // Build SSR inside RSC directory so wrangler can deploy self-contained dist/rsc
              build: {
                outDir: "./dist/rsc/ssr",
              },
              resolve: {
                // Ensure single React instance in SSR child environment
                dedupe: ["react", "react-dom"],
              },
              // Pre-bundle SSR entry and React for proper module linking with childEnvironments
              // All deps must be listed to avoid late discovery triggering ERR_OUTDATED_OPTIMIZED_DEP
              optimizeDeps: {
                entries: [finalEntries.ssr],
                include: [
                  "react",
                  "react-dom",
                  "react-dom/server.edge",
                  "react-dom/static.edge",
                  "react/jsx-runtime",
                  "react/jsx-dev-runtime",
                  "rsc-html-stream/server",
                  "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge",
                ],
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
              },
            },
            rsc: {
              // RSC environment needs exclude list and esbuild options
              // Exclude rsc-router modules to prevent createContext in RSC environment
              optimizeDeps: {
                // Pre-bundle all RSC deps to prevent late discovery triggering ERR_OUTDATED_OPTIMIZED_DEP
                include: [
                  "react",
                  "react/jsx-runtime",
                  "react/jsx-dev-runtime",
                  "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge",
                ],
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
              },
            },
          },
        };
      },

      configResolved(config) {
        if (showBanner) {
          const mode = config.command === "serve" ? (process.argv.includes("preview") ? "preview" : "dev") : "build";
          printBanner(mode, "cloudflare", _rangoVersion);
        }
      },

    });

    plugins.push(createVirtualEntriesPlugin(finalEntries));

    // Add RSC plugin with cloudflare-specific options
    // Note: loadModuleDevProxy should NOT be used with childEnvironments
    // since SSR runs in workerd alongside RSC
    plugins.push(
      rsc({
        get entries() {
          return finalEntries;
        },
        serverHandler: false,
      }) as PluginOption
    );
  } else {
    // Node preset: full RSC plugin integration
    const nodeOptions = resolvedOptions as RangoNodeOptions;
    routerPath = nodeOptions.router;

    // Auto-discover router when not specified
    if (!routerPath) {
      const earlyFilter = createScanFilter(process.cwd(), {
        include: resolvedOptions.include,
        exclude: resolvedOptions.exclude,
      });
      const candidates = findRouterFiles(process.cwd(), earlyFilter);
      if (candidates.length === 1) {
        // Convert absolute path to relative ./path
        const abs = candidates[0];
        const rel = abs.startsWith(process.cwd())
          ? "./" + abs.slice(process.cwd().length + 1)
          : abs;
        routerPath = rel;
      } else if (candidates.length > 1) {
        const cwd = process.cwd();
        const list = candidates
          .map((f) => "  - " + (f.startsWith(cwd) ? f.slice(cwd.length + 1) : f))
          .join("\n");
        throw new Error(
          `[rsc-router] Multiple routers found. Specify \`router\` to choose one:\n${list}`
        );
      }
      // 0 found: routerPath stays undefined, warn at startup via discovery plugin
    }

    const rscOption = nodeOptions.rsc ?? true;

    // Add RSC plugin by default (can be disabled with rsc: false)
    if (rscOption !== false) {
      // Dynamically import @vitejs/plugin-rsc
      const { default: rsc } = await import("@vitejs/plugin-rsc");

      // Resolve entry paths: use explicit config or virtual modules
      const userEntries =
        typeof rscOption === "boolean" ? {} : rscOption.entries || {};
      const finalEntries = {
        client: userEntries.client ?? VIRTUAL_IDS.browser,
        ssr: userEntries.ssr ?? VIRTUAL_IDS.ssr,
        rsc: userEntries.rsc ?? VIRTUAL_IDS.rsc,
      };

      // Track RSC entry for version injection (only if custom entry provided)
      rscEntryPath = userEntries.rsc ?? null;

      // Create wrapper plugin that checks for duplicates
      let hasWarnedDuplicate = false;

      plugins.push({
        name: "@rangojs/router:rsc-integration",
        enforce: "pre",

        config() {
          // Configure environments for RSC
          // When using virtual entries, we need to explicitly configure optimizeDeps
          // so Vite pre-bundles React before processing the virtual modules.
          // Without this, the dep optimizer may run multiple times with different hashes,
          // causing React instance mismatches.
          const useVirtualClient = finalEntries.client === VIRTUAL_IDS.browser;
          const useVirtualSSR = finalEntries.ssr === VIRTUAL_IDS.ssr;
          const useVirtualRSC = finalEntries.rsc === VIRTUAL_IDS.rsc;

          return {
            // Exclude rsc-router modules from optimization to prevent module duplication
            // This ensures the same Context instance is used by both browser entry and RSC proxy modules
            optimizeDeps: {
              exclude: excludeDeps,
              esbuildOptions: sharedEsbuildOptions,
            },
            build: {
              rollupOptions: { onwarn },
            },
            resolve: {
              alias: rangoAliases,
            },
            environments: {
              client: {
                build: {
                  rollupOptions: {
                    output: {
                      manualChunks: getManualChunks,
                    },
                  },
                },
                // Always exclude rsc-router modules, conditionally add virtual entry
                optimizeDeps: {
                  exclude: excludeDeps,
                  esbuildOptions: sharedEsbuildOptions,
                  ...(useVirtualClient && {
                    // Tell Vite to scan the virtual entry for dependencies
                    entries: [VIRTUAL_IDS.browser],
                  }),
                },
              },
              ...(useVirtualSSR && {
                ssr: {
                  optimizeDeps: {
                    entries: [VIRTUAL_IDS.ssr],
                    // Pre-bundle all SSR deps to prevent late discovery triggering ERR_OUTDATED_OPTIMIZED_DEP
                    include: [
                      "react",
                      "react-dom",
                      "react-dom/server.edge",
                      "react-dom/static.edge",
                      "react/jsx-runtime",
                      "react/jsx-dev-runtime",
                      "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge",
                    ],
                    exclude: excludeDeps,
                    esbuildOptions: sharedEsbuildOptions,
                  },
                },
              }),
              ...(useVirtualRSC && {
                rsc: {
                  optimizeDeps: {
                    entries: [VIRTUAL_IDS.rsc],
                    // Pre-bundle all RSC deps to prevent late discovery triggering ERR_OUTDATED_OPTIMIZED_DEP
                    include: [
                      "react",
                      "react/jsx-runtime",
                      "react/jsx-dev-runtime",
                      "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge",
                    ],
                    esbuildOptions: sharedEsbuildOptions,
                  },
                },
              }),
            },
          };
        },

        configResolved(config) {
          if (showBanner) {
            const mode = config.command === "serve" ? (process.argv.includes("preview") ? "preview" : "dev") : "build";
            printBanner(mode, "node", _rangoVersion);
          }

          // Count how many RSC base plugins there are (rsc:minimal is the main one)
          const rscMinimalCount = config.plugins.filter(
            (p) => p.name === "rsc:minimal"
          ).length;

          if (rscMinimalCount > 1 && !hasWarnedDuplicate) {
            hasWarnedDuplicate = true;
            console.warn(
              "[rsc-router] Duplicate @vitejs/plugin-rsc detected. " +
                "Remove rsc() from your config or use rango({ rsc: false }) for manual configuration."
            );
          }
        },
      });

      // Add virtual entries plugin
      plugins.push(createVirtualEntriesPlugin(finalEntries, routerPath));

      // Add the RSC plugin directly
      // Cast to PluginOption to handle type differences between bundled vite types
      plugins.push(
        rsc({
          entries: finalEntries,
        }) as PluginOption
      );
    }
  }

  // Fix HMR for "use client" components.
  //
  // @vitejs/plugin-rsc's hotUpdate returns undefined for "use client" files
  // in the RSC environment. Vite then tries to propagate through the RSC
  // module graph, but the proxy module has no import.meta.hot.accept()
  // boundary, causing a full page reload. The client env would handle it
  // fine via React Refresh, but the RSC env's full-reload arrives first.
  //
  // Fix: in the RSC env, return [] for "use client" files to signal
  // "handled, nothing to propagate". The client env is left alone so
  // React Refresh processes the update normally.
  plugins.push({
    name: "@rangojs/router:client-component-hmr",
    hotUpdate(ctx) {
      const envName = this.environment?.name;
      if (envName !== "rsc" && envName !== "ssr") return;

      // Check if the changed file is a "use client" module
      const file = ctx.file;
      if (!file.endsWith(".tsx") && !file.endsWith(".ts") && !file.endsWith(".jsx") && !file.endsWith(".js")) return;

      try {
        const source = readFileSync(file, "utf-8");
        const trimmed = source.trimStart();
        if (trimmed.startsWith('"use client"') || trimmed.startsWith("'use client'")) {
          // Consume the update in RSC/SSR envs. The proxy module was already
          // re-transformed by the RSC plugin's hotUpdate. Without this, Vite
          // tries to propagate through the RSC/SSR module graph where the proxy
          // has no import.meta.hot.accept() boundary, triggering a full reload.
          // The actual component update is handled by React Refresh in the
          // client environment.
          return [];
        }
      } catch {
        // File deleted/moved during HMR, let default handling proceed
      }
    },
  });

  plugins.push(exposeActionId());

  // Consolidated plugin for create* ID injection (enforce: "post"):
  // loaders, handles, location state, and prerender handlers.
  plugins.push(exposeInternalIds());

  // Router ID injection runs at normal priority (no enforce) to avoid
  // changing Vite's dep optimization timing.
  plugins.push(exposeRouterId());

  // Add version virtual module plugin for cache invalidation
  plugins.push(createVersionPlugin());

  // Resolve discovery entry path (used for both discovery and version injection).
  // Node preset: uses the (possibly auto-discovered) router path.
  // Cloudflare preset: auto-detects RSC entry from wrangler.json main field.
  const discoveryEntryPath = resolveDiscoveryEntryPath(
    resolvedOptions,
    preset !== "cloudflare" ? routerPath : undefined,
  );

  // Add version injector for custom entry.rsc files.
  // For Cloudflare preset, the RSC entry is the worker file (from wrangler.json).
  const injectorEntryPath = rscEntryPath ?? (preset === "cloudflare" ? discoveryEntryPath : null);
  if (injectorEntryPath) {
    plugins.push(createVersionInjectorPlugin(injectorEntryPath));
  }

  // Transform CJS vendor files to ESM for browser compatibility
  // optimizeDeps.include doesn't work because the file is loaded after initial optimization
  plugins.push(createCjsToEsmPlugin());

  // Add router discovery plugin for build-time manifest generation.
  if (discoveryEntryPath) {
    plugins.push(createRouterDiscoveryPlugin(discoveryEntryPath, {
      enableBuildPrerender: prerenderEnabled,
      staticRouteTypesGeneration: resolvedOptions.staticRouteTypesGeneration,
      include: resolvedOptions.include,
      exclude: resolvedOptions.exclude,
    }));
  }

  return plugins;
}



/**
 * Transform CJS vendor files from @vitejs/plugin-rsc to ESM for browser compatibility.
 * The react-server-dom vendor files are shipped as CJS which doesn't work in browsers.
 */
function createCjsToEsmPlugin(): Plugin {
  return {
    name: "@rangojs/router:cjs-to-esm",
    enforce: "pre",
    transform(code, id) {
      const cleanId = id.split("?")[0];

      // Transform the client.browser.js entry point to re-export from CJS
      if (
        cleanId.includes("vendor/react-server-dom/client.browser.js") ||
        cleanId.includes("vendor\\react-server-dom\\client.browser.js")
      ) {
        const isProd = process.env.NODE_ENV === "production";
        const cjsFile = isProd
          ? "./cjs/react-server-dom-webpack-client.browser.production.js"
          : "./cjs/react-server-dom-webpack-client.browser.development.js";

        return {
          code: `export * from "${cjsFile}";`,
          map: null,
        };
      }

      // Transform the actual CJS files to ESM
      if (
        (cleanId.includes("vendor/react-server-dom/cjs/") ||
          cleanId.includes("vendor\\react-server-dom\\cjs\\")) &&
        cleanId.includes("client.browser")
      ) {
        let transformed = code;

        // Extract the license comment to preserve it
        const licenseMatch = transformed.match(/^\/\*\*[\s\S]*?\*\//);
        const license = licenseMatch ? licenseMatch[0] : "";
        if (license) {
          transformed = transformed.slice(license.length);
        }

        // Remove "use strict" (both dev and prod have this)
        transformed = transformed.replace(/^\s*["']use strict["'];\s*/, "");

        // Remove the conditional IIFE wrapper (development only)
        transformed = transformed.replace(
          /^\s*["']production["']\s*!==\s*process\.env\.NODE_ENV\s*&&\s*\(function\s*\(\)\s*\{/,
          ""
        );

        // Remove the closing of the conditional IIFE at the end (development only)
        transformed = transformed.replace(/\}\)\(\);?\s*$/, "");

        // Replace require('react') and require('react-dom') with imports (development)
        transformed = transformed.replace(
          /var\s+React\s*=\s*require\s*\(\s*["']react["']\s*\)\s*,[\s\n]+ReactDOM\s*=\s*require\s*\(\s*["']react-dom["']\s*\)\s*,/g,
          'import React from "react";\nimport ReactDOM from "react-dom";\nvar '
        );

        // Replace require('react-dom') only (production - doesn't import React)
        transformed = transformed.replace(
          /var\s+ReactDOM\s*=\s*require\s*\(\s*["']react-dom["']\s*\)\s*,/g,
          'import ReactDOM from "react-dom";\nvar '
        );

        // Transform exports.xyz = function() to export function xyz()
        transformed = transformed.replace(
          /exports\.(\w+)\s*=\s*function\s*\(/g,
          "export function $1("
        );

        // Transform exports.xyz = value to export const xyz = value
        transformed = transformed.replace(
          /exports\.(\w+)\s*=/g,
          "export const $1 ="
        );

        // Reconstruct with license at the top
        transformed = license + "\n" + transformed;

        return {
          code: transformed,
          map: null,
        };
      }

      return null;
    },
  };
}
