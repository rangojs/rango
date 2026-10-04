import { parseAst, type Plugin } from "vite";
import {
  VIRTUAL_IDS,
  getVirtualBuildVersionContent,
  getVirtualVersionContent,
} from "./virtual-entries.js";
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
 * Plugin providing the `@rangojs/router:version` virtual module.
 *
 * Dev: exports a VERSION stamp used for both versions of every router. It
 * updates when the server starts and when an RSC module changes via HMR (the
 * version module is invalidated). Client-only HMR changes do not update it:
 * they do not affect server-rendered content or cached RSC payloads.
 *
 * Build: exports a placeholder for the per-router versions table. The module
 * holds nothing that varies between builds; the table is written into the
 * built chunk after the server output is hashed (the buildApp post hook in
 * router-discovery.ts). See docs/design/per-app-cache-version.md.
 * @internal
 */
export function createVersionPlugin(): Plugin {
  // Dev stamp, generated at plugin creation (server start).
  let currentVersion = Date.now().toString(16);
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
        return isDev
          ? getVirtualVersionContent(currentVersion)
          : getVirtualBuildVersionContent();
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
