import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/__tests__/',
        'tests/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/dist/',
        // Cookie handler tested in E2E (happy-dom doesn't support Cookie headers)
        'src/cookie-handler.ts',
        // Type-only files
        'src/types.ts',
        'src/index.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: {
      'host-router': '/src/index.ts',
    },
  },
});
