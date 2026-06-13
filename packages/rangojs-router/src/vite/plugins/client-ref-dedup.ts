import type { Plugin, ResolvedConfig } from "vite";
import { createRangoDebugger, NS } from "../debug.js";

const debug = createRangoDebugger(NS.transform);

const CLIENT_IN_SERVER_PROXY_PREFIX =
  "virtual:vite-rsc/client-in-server-package-proxy/";

/**
 * Extract the bare package name from an absolute node_modules path.
 * Handles scoped packages (@org/name) and nested node_modules.
 * Returns null if the path doesn't contain a valid package reference.
 *
 * NOTE: This is a lossy transformation. It maps a specific submodule path
 * (e.g., pkg/internal/context.js) to the package root (pkg). The load()
 * hook then re-exports via the bare specifier, which resolves to the
 * package entry point. This works for packages that barrel-export their
 * "use client" symbols from the root, which covers the common case
 * (component libraries like @mantine/core, @chakra-ui/react, etc.).
 * Packages whose client symbols are only available from deep subpaths
 * (not re-exported from the root) would lose those symbols after the
 * rewrite. A more precise approach would resolve through the package's
 * exports map to find the correct entry point, but that adds significant
 * complexity for a rare edge case.
 * See: https://github.com/cloudflare/vinext/pull/413
 */
export function extractPackageName(absolutePath: string): string | null {
  // Find the last /node_modules/ segment (handles nested node_modules)
  const marker = "/node_modules/";
  const idx = absolutePath.lastIndexOf(marker);
  if (idx === -1) return null;

  const afterModules = absolutePath.slice(idx + marker.length);

  if (afterModules.startsWith("@")) {
    // Scoped package: @org/name
    const parts = afterModules.split("/");
    if (parts.length < 2 || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }

  // Unscoped package: name
  const name = afterModules.split("/")[0];
  return name || null;
}

/**
 * Vite plugin that deduplicates client references from third-party packages
 * in dev mode.
 *
 * When @vitejs/plugin-rsc encounters a "use client" submodule inside a
 * package imported from a server component, it creates a
 * client-in-server-package-proxy virtual module that re-exports from the
 * absolute file path. In the client environment, this absolute path bypasses
 * Vite's pre-bundling, while direct client imports of the same package go
 * through .vite/deps/. Two separate module instances are created, breaking
 * React contexts (createContext runs twice, provider/consumer mismatch).
 *
 * This plugin intercepts absolute node_modules imports from proxy modules
 * in the client environment and rewrites them to bare specifier imports
 * that go through pre-bundling, ensuring a single module instance.
 *
 * Dev-only: production builds use the SSR manifest which handles module
 * identity correctly.
 */
export function clientRefDedup(): Plugin {
  let clientExclude: string[] = [];
  const dedupedPackages = new Set<string>();

  return {
    name: "@rangojs/router:client-ref-dedup",
    enforce: "pre",
    apply: "serve",

    configResolved(config: ResolvedConfig) {
      const clientEnv = config.environments?.["client"];
      clientExclude =
        clientEnv?.optimizeDeps?.exclude ?? config.optimizeDeps?.exclude ?? [];
    },

    buildEnd() {
      if (debug && dedupedPackages.size > 0) {
        debug(
          "client-ref-dedup: redirected %d package(s) (%s)",
          dedupedPackages.size,
          [...dedupedPackages].join(","),
        );
      }
    },

    resolveId(source, importer, options) {
      if (this.environment?.name !== "client") return;

      if (!importer?.includes(CLIENT_IN_SERVER_PROXY_PREFIX)) return;

      if (!source.includes("/node_modules/")) return;

      const packageName = extractPackageName(source);
      if (!packageName) return;

      if (clientExclude.includes(packageName)) return;

      if (debug) dedupedPackages.add(packageName);

      return `\0rango:dedup/${packageName}`;
    },

    load(id) {
      if (!id.startsWith("\0rango:dedup/")) return;

      const packageName = id.slice("\0rango:dedup/".length);

      return [
        `export * from ${JSON.stringify(packageName)};`,
        `import * as __all__ from ${JSON.stringify(packageName)};`,
        `export default __all__.default;`,
      ].join("\n");
    },
  };
}
