import { defineConfig } from "vite";
import path from "path";
import { rscRouter } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [
    rscRouter({
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
