import { cloudflare } from "@cloudflare/vite-plugin";
import { rscRouter } from "@rangojs/router/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    rscRouter(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: false,
    }),
  ],
});
