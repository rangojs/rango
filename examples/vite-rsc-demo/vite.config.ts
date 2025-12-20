import rsc from "@vitejs/plugin-rsc";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "path";
import { rscRouter } from "rsc-router/vite";
import devtoolsJson from "vite-plugin-devtools-json";

export default defineConfig({
  plugins: [react(), rsc(), rscRouter(), devtoolsJson()],
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
