import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  server: {
    port: 5003,
    // Bind to all interfaces for CI compatibility (fixes IPv6/IPv4 issues in Docker/Linux)
    host: process.env.CI ? "0.0.0.0" : undefined,
  },
  resolve: {
    // Ensure all environments resolve to the same experimental React instance,
    // preventing duplicate React copies when @rangojs/router depends on stable React.
    dedupe: ["react", "react-dom"],
  },
  plugins: [
    react(),
    rango({ preset: "cloudflare" }),
    cloudflare({
      configPath: "./wrangler.json",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
