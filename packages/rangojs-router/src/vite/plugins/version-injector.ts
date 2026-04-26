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

      // Always prepend `import "virtual:rsc-router/routes-manifest"` as the
      // first side-effect import. The manifest virtual module's `load()` hook
      // awaits `s.discoveryDone` so that, by the time the rest of the entry
      // including any module-level `router.reverse()` calls under `./router.js`
      // evaluates, runtime discovery has rewritten `router.named-routes.gen.ts`
      // with the full route table.
      //
      // ES module evaluation order matters here: while imports are *parsed*
      // hoisted, side-effect imports are evaluated in source order in the
      // dependency graph. A user-authored `import "virtual:rsc-router/..."`
      // placed after `import "./router.js"` runs too late: the manifest
      // gate fires after router.tsx has already crashed on a stale gen file.
      // We always prepend; ESM dedups any user-written duplicate, so module
      // initialization still runs once.
      const prepend: string[] = [
        `import "virtual:rsc-router/routes-manifest";`,
      ];

      // Auto-inject VERSION if file uses createRSCHandler without version
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

      // Insert after any leading `/// <reference ... />` triple-slash
      // directives (and surrounding blank lines). TypeScript requires those
      // directives to precede all other code; putting our imports above
      // them silently demotes the directives to plain comments.
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
