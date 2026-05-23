import { defineConfig, type Plugin } from "vite";
import path from "path";
import react from "@vitejs/plugin-react";
import { rango, poke } from "@rangojs/router/vite";
import devtoolsJson from "vite-plugin-devtools-json";
import { analyze } from "../../../../tools/bundle-analyze";
import { productionDefines } from "../../../../tools/vite-define";

// A third-party-style resolver: maps the "@parity/*" specifier to ./src/parity/*
// via a resolveId hook, deliberately WITHOUT a matching resolve.alias entry.
// This mirrors how vite-tsconfig-paths resolves tsconfig `paths` (issue #500)
// and is used to assert that discovery's temp runner forwards user resolveId
// plugins so build-time static/prerender rendering can resolve such specifiers.
function parityAliasPlugin(): Plugin {
  const prefix = "@parity/";
  const baseDir = path.resolve(__dirname, "./src/parity");
  return {
    name: "test-parity-alias",
    enforce: "pre",
    async resolveId(id, importer, options) {
      if (!id.startsWith(prefix)) return null;
      const target = path.resolve(baseDir, id.slice(prefix.length));
      const resolved = await this.resolve(target, importer, {
        skipSelf: true,
        ...options,
      });
      return resolved ?? undefined;
    },
  };
}

export default defineConfig(({ command }) => ({
  cacheDir:
    process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite-e2e-test-app",
  plugins: [
    parityAliasPlugin(),
    react(),
    rango(),
    devtoolsJson(),
    poke(),
    ...analyze(),
  ],
  define: productionDefines(command),
  oxc: {
    target: "es2022",
  },
  build: {
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
