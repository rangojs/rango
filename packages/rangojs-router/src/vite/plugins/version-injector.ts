import type { Plugin } from "vite";
import { resolve } from "node:path";
import * as Vite from "vite";
import { resolveRscEntryFromConfig } from "../utils/shared-utils.js";
import { RSC_ENTRY_BOOTSTRAP_IMPORTS } from "./virtual-entries.js";

/**
 * Plugin that auto-injects VERSION, routes-manifest, and loader-manifest into
 * custom entry.rsc files. If a custom entry.rsc file uses createRSCHandler but
 * doesn't pass version, this transform adds the import and property
 * automatically. It also ensures the routes-manifest and loader-manifest
 * virtual modules are always imported.
 *
 * The loader-manifest import is what makes fetchable loaders resolvable on a
 * custom worker entry. The virtual RSC entry (getVirtualEntryRSC) imports the
 * loader manifest itself, but a hand-written entry (e.g. a Cloudflare
 * worker.rsc.tsx) does not — so without this injection, setLoaderImports() is
 * never bundled, lazyLoaderImports stays null at runtime, and a fetchable
 * loader that is never imported by the server graph (not registered via
 * loader(), reachable only through a client component) cannot be found by the
 * _rsc_loader endpoint in production. Dev still works because it resolves
 * loaders by parsing their id into a file path; only production relied on the
 * manifest, hence the production-only failure this fixes.
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

      // Same startup bootstrap imports the generated virtual RSC entry uses,
      // from the single shared list so the two paths cannot drift.
      const prepend: string[] = RSC_ENTRY_BOOTSTRAP_IMPORTS.map(
        (id) => `import "${id}";`,
      );

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
