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
      // On CI, multiple Vite servers watch the same directory. Native inotify
      // watchers can miss events under this contention. Use polling instead.
      usePolling: !!process.env.CI,
      interval: 200,
    },
  },
});
