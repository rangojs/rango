import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

// E2e fixture for the per-router cache versions (e2e/cache-version.test.ts): a
// Cloudflare host router with two sub-apps on a CFCacheStore with KV, the store
// whose keys carry the versions. The suite copies this directory, edits the
// copy and rebuilds it between server starts, so its builds never touch the
// dist/ of the shared cloudflare-basic app. Lives in a dot-dir so the parent
// app's createRouter discovery (which skips dot-dirs) ignores it; resolves its
// dependencies through the parent's node_modules.
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: ".vite",
  plugins: [
    react(),
    rango({
      preset: "cloudflare",
      encryptionKey: process.env.RANGO_ENCRYPTION_KEY,
    }),
    cloudflare({
      configPath: "./wrangler.json",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      inspectorPort: false,
    }),
  ],
});
