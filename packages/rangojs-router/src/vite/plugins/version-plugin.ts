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
  const clientModuleSignatures = new Map<string, ClientModuleSignature>();

  const bumpVersion = (reason: string) => {
    currentVersion = Date.now().toString(16);
    console.log(`[rsc-router] ${reason}, version updated: ${currentVersion}`);

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
          }
        } catch {
          // Fail open: if we can't read or parse the update, invalidate.
        }
      }

      bumpVersion("RSC module changed");
    },
  };
}
