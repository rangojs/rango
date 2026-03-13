import { defineConfig } from "vite";
import path from "path";
import react from "@vitejs/plugin-react";
import { rango, poke } from "@rangojs/router/vite";
import devtoolsJson from "vite-plugin-devtools-json";

export default defineConfig({
  plugins: [
    react(),
    rango({
      router: "./src/router.tsx",
      // Using virtual entries (no explicit entries specified)
    }),
    devtoolsJson(),
    poke(),
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
