import { parseAst, type Plugin } from "vite";
import { VIRTUAL_IDS, getVirtualVersionContent } from "./virtual-entries.js";
import { hasUseClientDirective } from "../utils/directive-prologue.js";

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
  // Same leading-directive sniff the rango HMR plugin uses (shared helper, so the
  // two agree on what counts as a client module). A parse failure yields false.
  if (!hasUseClientDirective(source)) return undefined;

  let program: any;
  try {
    program = parseAst(source, { lang: "tsx" });
  } catch {
    return undefined;
  }

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

    // The build-time shell capture phase (producer B, #699) stamps entries
    // with THIS instance's version — the value folded into the shipped worker
    // — never the discovery temp server's own version-plugin value (a
    // different Date.now() stamp that would fail the serve-side gate).
    api: {
      getBuildVersion: (): string => currentVersion,
    },

    configResolved(config) {
      isDev = config.command === "serve";
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

    async hotUpdate(ctx) {
      if (!isDev) return;

      const isRscModule = this.environment?.name === "rsc";

      if (!isRscModule) return;

      if (isViteDepCachePath(ctx.file, resolvedCacheDir)) return;

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
              if (ctx.modules.length === 0) return;
            }
          }
        } catch {}
      } else {
        if (ctx.modules.length === 0) return;
      }

      bumpVersion("RSC module changed");
    },
  };
}

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

  return (
    /\/node_modules\/\.vite[^/]*\//.test(normalized) ||
    normalized.includes("/.vite-isolated/")
  );
}
