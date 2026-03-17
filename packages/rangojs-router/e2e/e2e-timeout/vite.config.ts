import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [rango()],
  esbuild: {
    target: "es2022",
  },
  build: {
    sourcemap: true,
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
});
