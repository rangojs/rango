import type { Plugin } from "vite";
import { resolve } from "node:path";
import * as Vite from "vite";
import { resolveRscEntryFromConfig } from "../utils/shared-utils.js";

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
      if (!entryPath) entryPath = resolveRscEntryFromConfig(config);
      if (entryPath) {
        resolvedEntryPath = resolve(config.root, entryPath);
      }
    },

    transform(code, id) {
      if (!resolvedEntryPath) return null;
      const normalizedId = Vite.normalizePath(id);
      const normalizedEntry = Vite.normalizePath(resolvedEntryPath);

      if (normalizedId !== normalizedEntry) {
        return null;
      }

      const prepend: string[] = [
        `import "virtual:rsc-router/routes-manifest";`,
      ];

      let newCode = code;
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

      const lines = newCode.split("\n");
      let insertAt = 0;
      while (insertAt < lines.length) {
        const trimmed = lines[insertAt]!.trim();
        if (trimmed === "" || /^\/\/\/\s*<reference\b/.test(trimmed)) {
          insertAt++;
        } else {
          break;
        }
      }
      newCode = [
        ...lines.slice(0, insertAt),
        ...prepend,
        ...lines.slice(insertAt),
      ].join("\n");

      return {
        code: newCode,
        map: null,
      };
    },
  };
}
