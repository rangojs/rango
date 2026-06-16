import type { Plugin, ResolvedConfig } from "vite";
import * as Vite from "vite";
import { getPublishedPackageName } from "./package-resolution.js";
import { performanceTracksOptimizeDepsPlugin } from "../plugins/performance-tracks.js";
import {
  VIRTUAL_ENTRY_BROWSER,
  VIRTUAL_ENTRY_SSR,
  getVirtualEntryRSC,
  getVirtualEntryRSCHost,
  getVirtualVersionContent,
  VIRTUAL_IDS,
} from "../plugins/virtual-entries.js";

// Cloudflare preset: @cloudflare/vite-plugin sets optimizeDeps.entries (string
// or array) on the rsc environment. Single source for both the discovery plugin
// and the version injector so they target the same entry.
export function resolveRscEntryFromConfig(
  config: ResolvedConfig,
): string | undefined {
  const entries = (config.environments as any)?.["rsc"]?.optimizeDeps?.entries;
  if (typeof entries === "string") return entries;
  if (Array.isArray(entries) && entries.length > 0) return entries[0];
  return undefined;
}

/**
 * Rolldown plugin to provide the version virtual module during dependency
 * optimization. Vite 8 optimizes deps with Rolldown (a Rollup-style plugin
 * pipeline that is separate from the main plugin set), so this is a
 * resolveId/load plugin under optimizeDeps.rolldownOptions. Any dep pulled into
 * optimization that imports the version virtual module gets a "dev" stub here;
 * the real VERSION is injected into runtime modules by the version plugin.
 */
const versionRolldownPlugin = {
  name: "@rangojs/router-version",
  resolveId(id: string): string | undefined {
    if (id === VIRTUAL_IDS.version) return "\0" + VIRTUAL_IDS.version;
    return undefined;
  },
  load(id: string): string | undefined {
    if (id === "\0" + VIRTUAL_IDS.version) {
      return getVirtualVersionContent("dev");
    }
    return undefined;
  },
};

/**
 * Shared Rolldown options for dependency optimization (Vite 8).
 * Includes the version stub plugin and the performance-tracks RSDW patch.
 */
export const sharedRolldownOptions: {
  plugins: any[];
} = {
  plugins: [versionRolldownPlugin, performanceTracksOptimizeDepsPlugin()],
};

/**
 * Create a virtual modules plugin for default entry files.
 * Provides virtual module content when entries use VIRTUAL_IDS (no custom entry configured).
 */
export function createVirtualEntriesPlugin(
  entries: { client: string; ssr: string; rsc?: string },
  routerPathRef?: { path?: string; kind?: "router" | "host" },
): Plugin {
  // Build virtual modules map based on which entries use virtual IDs
  const virtualModules: Record<string, string> = {};

  if (entries.client === VIRTUAL_IDS.browser) {
    virtualModules[VIRTUAL_IDS.browser] = VIRTUAL_ENTRY_BROWSER;
  }
  if (entries.ssr === VIRTUAL_IDS.ssr) {
    virtualModules[VIRTUAL_IDS.ssr] = VIRTUAL_ENTRY_SSR;
  }

  // RSC entry is resolved lazily in load() because routerPath may be
  // set after plugin creation (e.g. by the auto-discover config() hook).
  // Track all known virtual IDs for resolveId (content is separate).
  const knownIds = new Set(Object.keys(virtualModules));
  if (entries.rsc === VIRTUAL_IDS.rsc) {
    knownIds.add(VIRTUAL_IDS.rsc);
  }

  return {
    name: "@rangojs/router:virtual-entries",
    enforce: "pre",

    resolveId(id) {
      if (knownIds.has(id)) {
        return "\0" + id;
      }
      // Handle if the id already has the null prefix (RSC plugin wrapper imports)
      if (id.startsWith("\0") && knownIds.has(id.slice(1))) {
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
        // Lazy RSC entry: routerPath may have been set by a config() hook
        if (virtualId === VIRTUAL_IDS.rsc && routerPathRef?.path) {
          const raw = routerPathRef.path.startsWith(".")
            ? "/" + routerPathRef.path.slice(2) // ./src/router.tsx -> /src/router.tsx
            : routerPathRef.path;
          // Normalize backslashes for Windows (path.join/slice preserve native separators)
          const absoluteRouterPath = raw.replaceAll("\\", "/");
          return routerPathRef.kind === "host"
            ? getVirtualEntryRSCHost(absoluteRouterPath)
            : getVirtualEntryRSC(absoluteRouterPath);
        }
      }
      return null;
    },
  };
}

// Matches rollup's FILE_NAME_CONFLICT message and reports whether the colliding
// file is a content-hashed asset, e.g.
//   The emitted file "assets/index-DlGNrvnU.css" overwrites a previously ...
//   The emitted file "assets/inter-latin-Dx4kXJAl.woff2" overwrites a ...
// The match is UNANCHORED on purpose: by the time the warning reaches this user
// onwarn handler, Vite's logger has wrapped rollup's raw message with an ANSI
// color sequence and a "[CODE] " label, e.g.
//   "[33m[FILE_NAME_CONFLICT] [0mThe emitted file \"...\" overwrites ..."
// A "^The emitted file" anchor sits behind that prefix and never matches; and
// Vite also strips the JSON.stringify quotes rollup puts around the filename, so
// the match is UNANCHORED and quote-OPTIONAL ("?...?"?). The non-whitespace
// capture stops at the space before "overwrites" (Vite's unquoted display form)
// or the closing quote (raw rollup form); either way it carries no ANSI.
// A content-hashed name ends with a "-" separator + a Vite content hash. The
// hash is a FIXED-LENGTH base64url run ([A-Za-z0-9_-], default 8), so it can
// itself contain "-"/"_": it CANNOT be located by splitting on the last "-"
// (that lands inside the hash whenever it carries a dash, e.g. "...-Cabi7G8-" ->
// "" or "...-CkhJZR-_" -> "_", which let those conflicts leak). Instead take the
// trailing HASH_LEN chars and require the "-" separator right before them. The
// hash must hold an uppercase letter or digit (a real hash is never an
// all-lowercase word), so stable names like "assets/manifest.json" or
// "assets/loading-skeleton.css" still surface as potential genuine overwrites.
function isContentHashedAssetConflict(message: string | undefined): boolean {
  if (!message) return false;
  const match =
    /The emitted file "?([^"\s]+)"? overwrites a previously emitted file/.exec(
      message,
    );
  if (!match) return false;
  const fileName = match[1];
  const base = fileName.slice(fileName.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  const stem = base.slice(0, dot);
  // HASH_LEN tracks Vite's default [hash] width; bump it if an app sets a custom
  // assetFileNames hash length.
  const HASH_LEN = 8;
  if (stem.length < HASH_LEN + 1 || stem[stem.length - HASH_LEN - 1] !== "-") {
    return false;
  }
  const hash = stem.slice(-HASH_LEN);
  return /^[A-Za-z0-9_-]+$/.test(hash) && /[A-Z0-9]/.test(hash);
}

/**
 * Suppress known harmless warnings: "use client" directives, sourcemap errors,
 * mixed imports (expected for router internals), empty bundles, and content-hashed
 * asset collisions from @vitejs/plugin-rsc copying RSC-env assets to the client bundle.
 */
export function onwarn(
  warning: Vite.Rollup.RollupLog,
  defaultHandler: (warning: Vite.Rollup.RollupLog) => void,
): void {
  if (
    warning.code === "MODULE_LEVEL_DIRECTIVE" ||
    warning.code === "SOURCEMAP_ERROR" ||
    warning.code === "EMPTY_BUNDLE" ||
    warning.code === "INEFFECTIVE_DYNAMIC_IMPORT"
  ) {
    return;
  }
  if (
    warning.code === "FILE_NAME_CONFLICT" &&
    isContentHashedAssetConflict(warning.message)
  ) {
    return;
  }
  if (warning.message?.includes("Sourcemap is likely to be incorrect")) {
    return;
  }
  if (
    warning.plugin === "vite:reporter" &&
    warning.message?.includes(
      "dynamic import will not move module into another chunk",
    )
  ) {
    return;
  }
  defaultHandler(warning);
}

export function getManualChunks(id: string): string | undefined {
  const normalized = Vite.normalizePath(id);

  if (
    normalized.includes("node_modules/react/") ||
    normalized.includes("node_modules/react-dom/") ||
    normalized.includes("node_modules/react-server-dom-webpack/") ||
    normalized.includes("node_modules/@vitejs/plugin-rsc/")
  ) {
    return "react";
  }
  const packageName = getPublishedPackageName();
  if (
    normalized.includes(`node_modules/${packageName}/`) ||
    /\/packages\/(rsc-router|rangojs-router)\/(src|dist)\//.test(normalized)
  ) {
    return "router";
  }
  return undefined;
}
