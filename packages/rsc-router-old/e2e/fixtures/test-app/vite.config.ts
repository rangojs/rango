import { defineConfig } from 'vite';
import rsc from '@vitejs/plugin-rsc';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [rsc(), react()],
  server: {
    port: 3002,
  },
  environments: {
    rsc: {
      build: {
        rollupOptions: {
          input: { index: './src/entry.rsc.tsx' },
        },
      },
    },
    ssr: {
      build: {
        rollupOptions: {
          input: { index: './src/entry.ssr.tsx' },
        },
      },
    },
    client: {
      build: {
        rollupOptions: {
          input: { index: './src/entry.browser.tsx' },
        },
      },
    },
  },
});
