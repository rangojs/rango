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
  // react/react-dom dedupe is injected automatically by rango() across all
  // three RSC environments (see resolve.dedupe in the plugin's config hook),
  // so this app no longer needs to declare it manually even though it pins an
  // experimental React that differs from the router's peer range.
  plugins: [
    react(),
    rango({ preset: "cloudflare" }),
    cloudflare({
      configPath: "./wrangler.json",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
