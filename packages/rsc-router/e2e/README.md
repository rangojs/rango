# E2E Tests for RSC Router

End-to-end tests using Playwright to validate the router in a real browser environment with vite-plugin-rsc.

## Running E2E Tests

```bash
# Install Playwright browsers (first time only)
npx playwright install

# Run all E2E tests
pnpm test:e2e

# Run with UI
pnpm test:e2e:ui

# Run in headed mode (see browser)
pnpm test:e2e:headed
```

## Test Structure

```
e2e/
├── README.md                    # This file
├── helpers.ts                   # Test utilities
├── navigation.spec.ts           # Basic navigation tests
└── fixtures/
    └── test-app/                # E2E test application
        ├── src/
        │   ├── router.tsx       # Router configuration
        │   ├── entry.rsc.tsx    # Server entry (uses framework)
        │   ├── entry.browser.tsx # Client entry (uses framework)
        │   └── entry.ssr.tsx    # SSR entry (uses framework)
        ├── vite.config.ts       # vite-plugin-rsc setup
        └── package.json
```

## Test App

The test app (`fixtures/test-app/`) is a minimal RSC application using the router framework. It runs on port 3002 during tests and provides routes for testing:

- `/` - Home page
- `/about` - About page
- `/blog` - Blog index
- `/blog/:slug` - Blog posts (dynamic route)
- `/dashboard` - Dashboard

## Test Coverage

Phase 9.1 provides the infrastructure. Phase 9.2 will add comprehensive tests for:
- SPA navigation
- Partial rendering validation
- Segment management
- Layouts and parallel routes
- RSC streaming
- Browser history

## CI/CD

Tests can run in CI with:
```bash
CI=1 pnpm test:e2e
```

This will:
- Use fewer workers
- Enable retries
- Run in headless mode
