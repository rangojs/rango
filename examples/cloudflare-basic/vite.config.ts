import { cloudflare } from "@cloudflare/vite-plugin";
import rsc from "@vitejs/plugin-rsc";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Plugin to ensure resolvedUrls is available during cloudflare plugin startup
function ensureResolvedUrls(): Plugin {
  return {
    name: "ensure-resolved-urls",
    enforce: "pre",
    configureServer(server) {
      // Set resolvedUrls immediately based on config
      // This allows RSC plugin to have the origin during transform
      const port = server.config.server.port ?? 5173;
      const host = server.config.server.host || "localhost";
      const https = server.config.server.https;
      const protocol = https ? "https" : "http";
      const hostStr = typeof host === "string" ? host : "localhost";

      // Pre-populate resolvedUrls so RSC plugin can use it
      if (!server.resolvedUrls) {
        (server as any).resolvedUrls = {
          local: [`${protocol}://${hostStr}:${port}/`],
          network: [],
        };
      }
    },
  };
}

export default defineConfig(() => {
  return {
    server: {
      port: 5001,
      // strictPort: true,
    },
    plugins: [
      ensureResolvedUrls(),
      rsc({
        loadModuleDevProxy: true,
        serverHandler: false, // Cloudflare handles requests via workerd
      }),
      react(),
      cloudflare({
        configPath: "./wrangler.json",
        viteEnvironment: { name: "rsc" },
      }),
    ],

    environments: {
      rsc: {
        build: {
          rollupOptions: {
            input: { index: "./src/worker.rsc.tsx" },
          },
        },
      },
      ssr: {
        build: {
          rollupOptions: {
            input: { index: "./src/entry.ssr.tsx" },
          },
        },
      },
      client: {
        build: {
          rollupOptions: {
            input: { index: "./src/entry.browser.tsx" },
          },
        },
      },
    },
  };
});
