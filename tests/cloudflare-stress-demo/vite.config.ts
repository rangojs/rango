import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";
import { analyze } from "../../tools/bundle-analyze";

export default defineConfig({
  server: {
    port: 5002, // Different port to avoid conflicts
    host: process.env.CI ? "0.0.0.0" : undefined,
  },
  plugins: [
    react(),
    rango({ preset: "cloudflare" }),
    cloudflare({
      configPath: "./wrangler.json",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
    ...analyze(),
  ],
});
