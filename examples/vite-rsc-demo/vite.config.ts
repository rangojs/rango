import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "path";
import { rango } from "@rangojs/router/vite";
import devtoolsJson from "vite-plugin-devtools-json";

export default defineConfig({
  plugins: [
    react(),
    rango({
      router: "./src/router.tsx",
      // Uses virtual entries by default (no explicit entries needed)
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
