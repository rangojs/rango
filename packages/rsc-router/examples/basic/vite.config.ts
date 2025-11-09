/**
 * Example App - Vite Configuration
 *
 * Demonstrates proper setup with vite-plugin-rsc and three environments
 */

import { defineConfig } from 'vite';
import rsc from '@vitejs/plugin-rsc';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    // RSC plugin for React Server Components
    rsc({
      // Default settings work great!
      // The plugin sets up request handler from entry.rsc.tsx default export
    }),

    // React plugin for client-side HMR
    react(),
  ],

  server: {
    port: 3001,
  },

  // Three environments for RSC architecture
  environments: {
    // RSC environment (react-server condition)
    // Responsible for:
    // - RSC stream serialization (React VDOM → RSC stream)
    // - Server function handling
    rsc: {
      build: {
        rollupOptions: {
          input: {
            index: './entry.rsc.tsx',
          },
        },
      },
    },

    // SSR environment (no react-server condition)
    // Responsible for:
    // - RSC stream deserialization (RSC stream → React VDOM)
    // - Traditional SSR (React VDOM → HTML string/stream)
    ssr: {
      build: {
        rollupOptions: {
          input: {
            index: './entry.ssr.tsx',
          },
        },
      },
    },

    // Client environment
    // Responsible for:
    // - RSC stream deserialization (RSC stream → React VDOM)
    // - CSR (React VDOM → Browser DOM)
    // - Hydration
    // - Client-side navigation
    // - Server function calls
    client: {
      build: {
        rollupOptions: {
          input: {
            index: './entry.browser.tsx',
          },
        },
      },
    },
  },
});
