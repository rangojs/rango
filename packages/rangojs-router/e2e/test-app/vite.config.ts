import { defineConfig } from "vite";
import path from "path";
import react from "@vitejs/plugin-react";
import { rango } from "@rangojs/router/vite";
import devtoolsJson from "vite-plugin-devtools-json";

export default defineConfig({
  plugins: [
    react(),
    rango({
      router: "./src/router.tsx",
      // Using virtual entries (no explicit entries specified)
    }),
    devtoolsJson(),
  ],
  esbuild: {
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
  server: {
    watch: {
      // Native inotify works well on GitHub Actions Ubuntu VMs and handles
      // multiple concurrent watchers better than polling (no stat contention).
      // Polling was previously used here but missed events on CI due to the
      // 200ms interval being too coarse for rapid test file writes.
    },
  },
});
