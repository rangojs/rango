import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "path";
import { rscRouter } from "rsc-router/vite";
import devtoolsJson from "vite-plugin-devtools-json";

export default defineConfig({
  plugins: [
    react(),
    rscRouter({
      rsc: {
        entries: {
          client: "./src/entry.browser.tsx",
          ssr: "./src/entry.ssr.tsx",
          rsc: "./src/entry.rsc.tsx",
        },
      },
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
});
