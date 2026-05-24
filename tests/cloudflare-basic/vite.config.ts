import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rango } from "@rangojs/router/vite";
import { analyze } from "../../tools/bundle-analyze";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A third-party-style resolver: maps "@parity/*" to ./src/parity/* via a
// resolveId hook, deliberately WITHOUT a matching resolve.alias entry. Mirrors
// how vite-tsconfig-paths resolves tsconfig `paths` (issue #500) and asserts
// that cloudflare discovery's temp runner forwards user resolveId plugins so
// build-time static/prerender rendering can resolve such specifiers.
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

export default defineConfig({
  server: {
    port: 5001,
    // Bind to all interfaces for CI compatibility (fixes IPv6/IPv4 issues in Docker/Linux)
    host: process.env.CI ? "0.0.0.0" : undefined,
  },
  resolve: {
    // Vite 8 native tsconfig paths resolution. The "@native/*" mapping in
    // tsconfig.json is resolved by this flag alone (no resolve.alias, no
    // resolveId plugin), exercising that the cloudflare discovery runner
    // forwards the native tsconfigPaths flag into its temp server.
    tsconfigPaths: true,
  },
  plugins: [
    parityAliasPlugin(),
    react(),
    rango({ preset: "cloudflare", buildEnv: "auto" }),
    cloudflare({
      configPath: "./wrangler.json",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      inspectorPort: false,
    }),
    ...analyze(),
  ],
});
