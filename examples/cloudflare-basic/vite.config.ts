import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rscRouter } from "rsc-router/vite";

export default defineConfig({
  server: {
    port: 5001,
  },
  plugins: [
    react(),
    rscRouter({ preset: "cloudflare" }),
    cloudflare({
      configPath: "./wrangler.json",
      viteEnvironment: { name: "rsc" },
    }),
  ],
});
