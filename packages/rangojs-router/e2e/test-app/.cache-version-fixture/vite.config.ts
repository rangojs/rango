import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { rango } from "@rangojs/router/vite";

// E2e fixture for the per-router cache versions (cache-version.test.ts): a
// node-preset host router with two sub-apps and a cache store that survives a
// server restart. The suite copies this directory, edits the copy and rebuilds
// it between server starts, so its builds never touch the dist/ of the shared
// test-app. Lives in a dot-dir so the parent test-app's createRouter discovery
// (which skips dot-dirs) ignores it; resolves its dependencies through the
// test-app's node_modules.
export default defineConfig(({ command }) => ({
  root: import.meta.dirname,
  plugins: [
    react(),
    rango({
      preset: "node",
      hostRouter: "./src/host.rsc.tsx",
      encryptionKey: process.env.RANGO_ENCRYPTION_KEY,
    }),
  ],
  define:
    command === "build"
      ? { "process.env.NODE_ENV": JSON.stringify("production") }
      : undefined,
  cacheDir: ".vite",
  server: { allowedHosts: true },
  preview: { allowedHosts: true },
}));
