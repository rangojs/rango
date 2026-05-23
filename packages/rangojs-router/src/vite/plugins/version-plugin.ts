import { parseAst, type Plugin } from "vite";
import { VIRTUAL_IDS, getVirtualVersionContent } from "./virtual-entries.js";

interface ClientModuleSignature {
  key: string;
}

function isCodeModule(id: string): boolean {
  return /\.(tsx?|jsx?)($|\?)/.test(id);
}

function normalizeModuleId(id: string): string {
  return id.split("?", 1)[0];
}

function getClientModuleSignature(
  source: string,
): ClientModuleSignature | undefined {
  let program: any;
  try {
    program = parseAst(source, { jsx: true });
  } catch {
    return undefined;
  }

  let isUseClient = false;
  for (const node of program.body ?? []) {
    if (
      node?.type === "ExpressionStatement" &&
      node.expression?.type === "Literal" &&
      typeof node.expression.value === "string"
    ) {
      if (node.expression.value === "use client") {
        isUseClient = true;
      }
      continue;
    }
    break;
  }

  if (!isUseClient) return undefined;

  const exports = new Set<string>();
  let hasDefault = false;
  let hasExportAll = false;

  const collectBindingNames = (pattern: any) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      exports.add(pattern.name);
    } else if (pattern.type === "ObjectPattern") {
      for (const prop of pattern.properties ?? []) {
        if (prop?.type === "RestElement") {
          collectBindingNames(prop.argument);
        } else {
          collectBindingNames(prop?.value);
        }
      }
    } else if (pattern.type === "ArrayPattern") {
      for (const el of pattern.elements ?? []) {
        if (el?.type === "RestElement") {
          collectBindingNames(el.argument);
        } else {
          collectBindingNames(el);
        }
      }
    }
  };

  const collectDeclarationNames = (declaration: any) => {
    if (!declaration) return;
    if (declaration.type === "VariableDeclaration") {
      for (const decl of declaration.declarations ?? []) {
        collectBindingNames(decl?.id);
      }
      return;
    }
    collectBindingNames(declaration.id);
  };

  for (const node of program.body ?? []) {
    if (node?.type === "ExportDefaultDeclaration") {
      hasDefault = true;
      continue;
    }
    if (node?.type === "ExportAllDeclaration") {
      hasExportAll = true;
      continue;
    }
    if (node?.type !== "ExportNamedDeclaration") continue;

    collectDeclarationNames(node.declaration);

    for (const specifier of node.specifiers ?? []) {
      const exportedName =
        specifier?.exported?.name ?? specifier?.exported?.value;
      if (exportedName === "default") {
        hasDefault = true;
      } else if (typeof exportedName === "string") {
        exports.add(exportedName);
      }
    }
  }

  return {
    key: JSON.stringify({
      default: hasDefault,
      exportAll: hasExportAll,
      exports: [...exports].sort(),
    }),
  };
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
export function createVersionPlugin(): Plugin {
  // Generate version at plugin creation time (build/server start)
  const buildVersion = Date.now().toString(16);
  let currentVersion = buildVersion;
  let isDev = false;
  let server: any = null;
  let resolvedCacheDir: string | undefined;
  const clientModuleSignatures = new Map<string, ClientModuleSignature>();

  let versionCounter = 0;
  const bumpVersion = (reason: string) => {
    // Use timestamp + counter to guarantee uniqueness even when multiple
    // bumps happen within the same millisecond (e.g. cascading HMR events).
    currentVersion = Date.now().toString(16) + String(++versionCounter);
    console.log(`[rango] ${reason}, version updated: ${currentVersion}`);

    const rscEnv = server?.environments?.rsc;
    const versionMod = rscEnv?.moduleGraph?.getModuleById(
      "\0" + VIRTUAL_IDS.version,
    );
    if (versionMod) {
      rscEnv.moduleGraph.invalidateModule(versionMod);
    }
  };

  return {
    name: "@rangojs/router:version",
    enforce: "pre",

    configResolved(config) {
      isDev = config.command === "serve";
      // Capture the resolved cacheDir so we can ignore optimizer-output
      // writes inside it. Vite resolves cacheDir against the project root,
      // so this is a stable absolute path for the lifetime of the server.
      resolvedCacheDir = config.cacheDir
        ? String(config.cacheDir).replace(/\\/g, "/")
        : undefined;
    },

    configureServer(devServer) {
      server = devServer;

      devServer.watcher.on("unlink", (filePath) => {
        if (!isDev) return;
        if (!clientModuleSignatures.has(filePath)) return;
        clientModuleSignatures.delete(filePath);
        bumpVersion("Client module removed");
      });
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

    transform(code, id) {
      if (!isDev || !isCodeModule(id)) return null;
      const normalizedId = normalizeModuleId(id);
      if (
        !code.includes("use client") &&
        !clientModuleSignatures.has(normalizedId)
      ) {
        return null;
      }

      const signature = getClientModuleSignature(code);
      if (signature) {
        clientModuleSignatures.set(normalizedId, signature);
      } else {
        clientModuleSignatures.delete(normalizedId);
      }
      return null;
    },

    // Track RSC module changes and update version
    async hotUpdate(ctx) {
      if (!isDev) return;

      // Check if this is an RSC environment update (not client/ssr)
      // RSC modules affect server-rendered content and cached payloads
      // In Vite 6, environment is accessed via `this.environment`
      const isRscModule = this.environment?.name === "rsc";

      if (!isRscModule) return;

      // Skip Vite's own pre-bundled dep cache writes. The optimizer rewrites
      // files inside the configured `cacheDir` on every discovery cycle
      // (and when other dev servers under the same cwd populate their own
      // isolated cache dirs). These are not user-source changes, so bumping
      // the app version on them produces spurious version mismatches that
      // surface as forced reloads on in-flight actions.
      if (isViteDepCachePath(ctx.file, resolvedCacheDir)) return;

      // Skip re-bumping when the version virtual module itself is invalidated
      // (our own bumpVersion() invalidates it, which re-triggers hotUpdate).
      if (
        ctx.modules.length === 1 &&
        ctx.modules[0].id === "\0" + VIRTUAL_IDS.version
      ) {
        return;
      }

      if (isCodeModule(ctx.file)) {
        const filePath = normalizeModuleId(ctx.file);
        const previousSignature = clientModuleSignatures.get(filePath);
        try {
          const source = await ctx.read();
          const nextSignature = getClientModuleSignature(source);
          if (nextSignature) {
            // "use client" file — compare export signatures.
            // client-component-hmr may have cleared ctx.modules, so we
            // cannot rely on ctx.modules.length for these files.
            clientModuleSignatures.set(filePath, nextSignature);
            if (
              previousSignature &&
              previousSignature.key === nextSignature.key
            ) {
              return;
            }
          } else {
            clientModuleSignatures.delete(filePath);
            if (!previousSignature) {
              // Not and never was "use client" — use module graph check.
              // ctx.modules is reliable for pure server files (only
              // client-component-hmr clears it for "use client" modules).
              if (ctx.modules.length === 0) return;
            }
            // Was "use client" but directive removed — boundary changed,
            // bump below.
          }
        } catch {
          // Fail open: if we can't read or parse the update, invalidate.
        }
      } else {
        // Non-code file (json, css, etc.) — only bump if it's actually
        // referenced by the RSC module graph.
        if (ctx.modules.length === 0) return;
      }

      bumpVersion("RSC module changed");
    },
  };
}

/**
 * Match Vite's pre-bundled dep cache directories. These paths are rewritten
 * by the dep optimizer (and by isolated test fixtures sharing the same cwd),
 * not by user source changes, so they should not bump the app version (which
 * would force a client reload mid-request).
 *
 * Two checks:
 * 1. Anything inside the resolved `cacheDir` (precise — covers custom paths
 *    like the `RANGO_E2E_VITE_CACHE_DIR` overrides in the test fixtures).
 * 2. Heuristic match for any `node_modules/.vite*` directory or a
 *    `.vite-isolated/` segment anywhere in the path. This catches the
 *    *other* dev servers in the same cwd whose cacheDir we cannot read
 *    (we only see config of the server we're attached to).
 */
export function isViteDepCachePath(
  filePath: string | undefined,
  cacheDir?: string,
): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");

  if (cacheDir) {
    const normalizedCacheDir = cacheDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (
      normalized === normalizedCacheDir ||
      normalized.startsWith(normalizedCacheDir + "/")
    ) {
      return true;
    }
  }

  // Vite/optimizer convention: cache dirs always sit directly under
  // `node_modules/` and start with `.vite` (e.g. `.vite`, `.vite-temp`,
  // `.vite_rango_generate`, `.vite-e2e-test-app`). The `/.vite-isolated/`
  // segment covers the test-fixture pattern that places the cache outside
  // node_modules.
  return (
    /\/node_modules\/\.vite[^/]*\//.test(normalized) ||
    normalized.includes("/.vite-isolated/")
  );
}
