import type { Plugin } from "vite";
import { resolve } from "node:path";
import * as Vite from "vite";

/**
 * Plugin that auto-injects VERSION and routes-manifest into custom entry.rsc files.
 * If a custom entry.rsc file uses createRSCHandler but doesn't pass version,
 * this transform adds the import and property automatically.
 * Also ensures the routes-manifest virtual module is always imported.
 * @internal
 */
export function createVersionInjectorPlugin(
  rscEntryPath: string | undefined,
): Plugin {
  let resolvedEntryPath = "";

  return {
    name: "@rangojs/router:version-injector",
    enforce: "pre",

    configResolved(config) {
      let entryPath = rscEntryPath;
      // Cloudflare preset: read entry from resolved environment config.
      // The @cloudflare/vite-plugin reads wrangler config (toml/json/jsonc)
      // and sets optimizeDeps.entries on the RSC environment.
      if (!entryPath) {
        const rscEnvConfig = (config.environments as any)?.["rsc"];
        const entries = rscEnvConfig?.optimizeDeps?.entries;
        if (typeof entries === "string") {
          entryPath = entries;
        } else if (Array.isArray(entries) && entries.length > 0) {
          entryPath = entries[0];
        }
      }
      if (entryPath) {
        resolvedEntryPath = resolve(config.root, entryPath);
      }
    },

    transform(code, id) {
      if (!resolvedEntryPath) return null;
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
          "createRSCHandler({\n  version: VERSION,",
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
