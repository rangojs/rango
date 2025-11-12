# Host Router

A routing system for managing multi-application hosting based on domain/subdomain patterns with support for cookie-based host override for development environments.

## Features

- **Host-based Routing** - Route requests based on hostname patterns (apex, subdomains, paths)
- **Flexible Patterns** - Support for wildcards, specific domains, and path-based routing
- **Cookie Override** - Test different apps locally using cookies (no DNS changes needed)
- **Middleware System** - Global and host-specific middleware with `async/await next()` pattern
- **Type-Safe** - Full TypeScript support with type-safe pattern definitions
- **Lazy Loading** - Dynamic imports for optimal code splitting
- **Testing Utilities** - Helpers for testing host routing logic
- **Zero Dependencies** - Lightweight and focused

## Installation

```bash
pnpm add host-router
```

## Quick Start

```typescript
import { createHostRouter } from 'host-router';

const router = createHostRouter();

// Main site on apex domain
router.host(['.']).map(() => import('./apps/main'));

// Admin panel on subdomain
router.host(['admin.*']).map(() => import('./apps/admin'));

// API on subdomain
router.host(['api.*']).map(() => import('./apps/api'));

export default {
  fetch(request) {
    return router.match(request);
  }
};
```

## Pattern Syntax

### Domain Patterns

- `.` or `*` - Any apex domain (e.g., `example.com`)
- `**` - Any domain (apex + all subdomains)
- `*.` - Any single-level subdomain (e.g., `www.example.com`)
- `**.` - Any multi-level subdomain (e.g., `a.b.c.example.com`)

### Specific Domains

- `example.com` - Exact domain match
- `*.com` - Any apex .com domain
- `*.example.com` - Any subdomain of example.com
- `**.example.com` - Any depth subdomain of example.com
- `admin.*` - Admin subdomain of any apex domain

### Path Patterns

- `example.com/admin` - Specific domain with path prefix
- `./admin` - Any apex domain with `/admin` path
- `*./api` - Any subdomain with `/api` path
- `admin./blog` - Admin subdomain with `/blog` path

## Examples

### Basic Multi-App Setup

```typescript
import { createHostRouter } from 'host-router';

const router = createHostRouter();

router.host(['.', 'www.*']).map(() => import('./apps/main'));
router.host(['./admin']).map(() => import('./apps/admin'));
router.host(['api.*']).map(() => import('./apps/api'));

export default {
  fetch(request, env, ctx) {
    return router.match(request, { env, ctx });
  }
};
```

### With Middleware

```typescript
const router = createHostRouter();

// Global middleware
router.use(async (request, context, next) => {
  console.log('Request:', request.url);
  return next();
});

// Host-specific middleware
router
  .host(['admin.*'])
  .use(async (request, context, next) => {
    if (!context.user?.isAdmin) {
      return new Response('Unauthorized', { status: 401 });
    }
    return next();
  })
  .map(() => import('./apps/admin'));
```

### Cookie-Based Host Override

```typescript
const router = createHostRouter({
  hostOverride: {
    cookieName: 'x-requested-host',
    allowedHosts: ['localhost', '*.workers.dev'],
  }
});

router.host(['admin.*']).map(() => import('./apps/admin'));
router.host(['.']).map(() => import('./apps/main'));

// Now set cookie: x-requested-host=admin.example.com
// Visit http://localhost:3000 -> routes to admin app
```

### SaaS Multi-Tenant

```typescript
const router = createHostRouter();

// Marketing site
router.host(['.', 'www.*']).map(() => import('./apps/marketing'));

// Tenant subdomains
router
  .host(['*.'])
  .use(async (request, ctx, next) => {
    const url = new URL(request.url);
    const tenant = url.hostname.split('.')[0];
    ctx.tenant = await loadTenant(tenant);
    return next();
  })
  .map(() => import('./apps/tenant'));
```

### Type-Safe Patterns

```typescript
import { defineHosts } from 'host-router';

const hosts = defineHosts({
  admin: 'admin.*',
  api: 'api.*',
  app: ['.', 'www.*']
});

router.host(hosts.admin).map(() => import('./apps/admin'));
router.host(hosts.api).map(() => import('./apps/api'));
// TypeScript error if you typo: router.host(hosts.adnim)
```

## API Reference

### `createHostRouter(options?)`

Creates a new host router instance.

```typescript
interface HostRouterOptions {
  debug?: boolean;
  hostOverride?: {
    cookieName: string;
    allowedHosts: string[];
    validate?: (request: Request, cookieValue: string, context: any) => string;
  };
}
```

### `router.host(patterns)`

Register a host pattern.

```typescript
router.host(['admin.*', 'admin.example.com']).map(() => import('./apps/admin'));
```

### `router.use(...middleware)`

Register global middleware.

```typescript
router.use(async (request, context, next) => {
  // Before logic
  const response = await next();
  // After logic
  return response;
});
```

### `router.match(request, context?)`

Match an incoming request.

```typescript
const response = await router.match(request, { env, ctx });
```

### `router.fallback()`

Register fallback handler for allowed hosts without valid cookie.

```typescript
router.fallback().map(() => import('./apps/host-selector'));
```

### `router.test(hostname)`

Test which handler would match a hostname.

```typescript
const result = router.test('admin.example.com');
// Returns: { pattern: 'admin.*', handler: Function } or null
```

## Testing

### Test Utilities

```typescript
import { createTestRequest, testPattern } from 'host-router/testing';

// Create test requests
const request = createTestRequest({
  host: 'admin.example.com',
  path: '/dashboard',
  cookies: { 'x-requested-host': 'api.example.com' }
});

// Test patterns
expect(testPattern('admin.*', 'admin.example.com')).toBe(true);
```

### Running Tests

```bash
# Run unit tests
pnpm test

# Run with coverage
pnpm test:coverage

# Run E2E tests
pnpm test:e2e

# Run all tests
pnpm test:all
```

## Best Practices

### 1. Order Patterns by Specificity

```typescript
// ✅ Good: Most specific first
router.host(['admin.example.com']).map(...);
router.host(['admin.*']).map(...);
router.host(['.']).map(...);

// ❌ Bad: Catch-all first
router.host(['**']).map(...);
router.host(['admin.*']).map(...);  // Never reached
```

### 2. Use Host-Specific Middleware

```typescript
// ✅ Good: Auth only on admin
router.host(['admin.*']).use(requireAuth()).map(...);

// ❌ Bad: Auth on everything
router.use(requireAuth());  // Blocks public pages
```

### 3. Use Lazy Imports

```typescript
// ✅ Good: Lazy load
router.host(['admin.*']).map(() => import('./apps/admin'));

// ❌ Bad: Eager load
import adminApp from './apps/admin';
router.host(['admin.*']).map(() => adminApp);
```

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Type check
pnpm type-check

# Lint
pnpm lint

# Format
pnpm format

# Run all quality checks
pnpm quality
```

## License

MIT
