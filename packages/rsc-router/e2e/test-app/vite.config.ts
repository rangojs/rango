import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";
import path from "path";
import { rscRouter } from "rsc-router/vite";
import devtoolsJson from "vite-plugin-devtools-json";

export default defineConfig({
  plugins: [rsc(), rscRouter(), devtoolsJson()],
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
    rsc: {
      build: {
        rollupOptions: {
          input: {
            index: "./src/entry.rsc.tsx",
          },
        },
      },
    },

    ssr: {
      build: {
        rollupOptions: {
          input: {
            index: "./src/entry.ssr.tsx",
          },
        },
      },
    },

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
