import { defineConfig } from "vite";
import path from "path";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [
    rango({
      router: "./src/router.tsx",
    }),
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
