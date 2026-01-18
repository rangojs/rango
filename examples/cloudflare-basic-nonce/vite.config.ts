import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rscRouter } from "rsc-router/vite";

export default defineConfig({
  server: {
    port: 5002,
    // Bind to all interfaces for CI compatibility (fixes IPv6/IPv4 issues in Docker/Linux)
    host: process.env.CI ? "0.0.0.0" : undefined,
  },
  plugins: [
    react(),
    rscRouter({ preset: "cloudflare" }),
    cloudflare({
      configPath: "./wrangler.json",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
