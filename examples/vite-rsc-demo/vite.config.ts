import rsc from "@vitejs/plugin-rsc";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  plugins: [rsc(), react()],
  esbuild: {
    target: "es2022",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  environments: {
    // RSC environment - server-side React rendering
    rsc: {
      build: {
        rollupOptions: {
          input: {
            index: "./src/entry.rsc.tsx",
          },
        },
      },
    },

    // SSR environment - HTML generation
    ssr: {
      build: {
        rollupOptions: {
          input: {
            index: "./src/entry.ssr.tsx",
          },
        },
      },
    },

    // Client environment - browser hydration and navigation
    client: {
      build: {
        rollupOptions: {
          input: {
            index: "./src/entry.browser.tsx",
          },
        },
      },
    },
  },
});
