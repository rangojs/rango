# Host Router API

A routing system for managing multi-application hosting based on domain/subdomain patterns with support for cookie-based host override for development environments.

## Overview

The Host Router enables you to:

- Route requests to different applications based on hostname patterns
- Support multi-tenant SaaS applications with subdomain routing
- Override hostname via cookies for local development
- Apply middleware at the host level
- Lazy load applications for optimal performance

## Core API

### `createHostRouter(options?)`

Creates a new host router instance.

```typescript
import { createHostRouter } from 'rsc-router/host';

const router = createHostRouter({
  debug?: boolean;  // Enable debug logging
  hostOverride?: {
    cookieName: string;
    allowedHosts: string[];
    validate?: (request: Request, cookieValue: string, context: any) => string;
  }
});
```

### `.host(patterns)`

Registers a host pattern and returns a builder for configuration.

```typescript
router
  .host(pattern: string | string[])
  .use(...middleware: Middleware[])
  .map(handler: LazyImport | HandlerFunction)
```

### `.use(middleware)`

Registers global middleware that runs for all hosts.

```typescript
router.use(async (request, context, next) => {
  // Before logic
  const response = await next();
  // After logic
  return response;
});
```

### `.match(request, context?)`

Matches an incoming request against registered host patterns.

```typescript
export default {
  fetch(request, env, ctx) {
    return router.match(request, { env, ctx });
  },
};
```

### `.fallback()`

Registers a handler for when a request is on an allowed host but validation fails (no cookie or validate() throws).

```typescript
router.fallback().map((request, context) => {
  // context.error contains the validation error
  console.log("No host selected:", context.error);
  return import("./apps/host-selector");
});
```

### `.test(hostname)`

Tests which handler would match a given hostname (useful for debugging).

```typescript
const result = router.test("admin.example.com");
// Returns: { pattern: 'admin.*', handler: Function } or null
```

## Host Pattern Matching

### Pattern Syntax

#### Domain Patterns

- `.` - Matches any apex domain (e.g., `example.com`, `google.com`)
- `*` - Same as `.` - any apex domain
- `**` - Matches any domain (apex + all subdomains)
- `*.` - Matches any single-level subdomain (e.g., `api.example.com`, `www.google.com`)
- `**.` - Matches any multi-level subdomain (e.g., `a.b.example.com`, `staging.api.example.com`)

#### Specific Domain Patterns

- `example.com` - Exact domain match
- `*.com` - Any apex .com domain (e.g., `google.com`, `example.com`)
- `*.example.com` - Any single subdomain of example.com (e.g., `api.example.com`)
- `**.example.com` - Any depth subdomain of example.com (e.g., `a.b.c.example.com`)
- `admin.*` - Admin subdomain of any apex domain (e.g., `admin.google.com`)
- `admin.**` - Admin subdomain of any domain including subdomains

#### Path Patterns (Prefix Matching)

- `example.com/admin` - Specific apex domain with path (e.g., `example.com/admin/*`)
- `api.example.com/v2` - Specific subdomain with path (e.g., `api.example.com/v2/*`)
- `./admin` - Any apex domain with `/admin` path prefix (e.g., `example.com/admin/*`)
- `*./api` - Any single subdomain with `/api` path prefix (e.g., `api.example.com/api/*`)
- `admin./blog` - Admin subdomain with `/blog` path prefix (e.g., `admin.example.com/blog/*`)
- `**/dashboard` - Any domain with `/dashboard` path prefix

**Note**: Paths are normalized (trailing `/` removed) and match as prefixes.

### Pattern Examples

```typescript
// Apex domains only (no subdomains)
router.host(["."]).map(() => import("./apps/main"));
// ✅ Matches: example.com, google.com, example.com/anything
// ❌ Does NOT match: www.example.com, api.google.com

// Any single-level subdomain
router.host(["*."]).map(() => import("./apps/tenant"));
// ✅ Matches: tenant.example.com, api.google.com
// ❌ Does NOT match: example.com, a.b.example.com

// Multi-level subdomains
router.host(["**."]).map(() => import("./apps/preview"));
// ✅ Matches: pr-123.preview.example.com, a.b.c.example.com
// ❌ Does NOT match: example.com, api.example.com (single level)

// Any domain (catch-all)
router.host(["**"]).map(() => import("./apps/fallback"));
// ✅ Matches: ANY domain including example.com, www.example.com, a.b.c.example.com

// Path-based routing with any apex
router.host(["./admin"]).map(() => import("./apps/admin"));
// ✅ Matches: example.com/admin, example.com/admin/users
// ❌ Does NOT match: admin.example.com, example.com/api

// Specific domain with path
router.host(["google.com/admin"]).map(() => import("./apps/google-admin"));
// ✅ Matches: google.com/admin, google.com/admin/settings
// ❌ Does NOT match: www.google.com/admin, google.com/api
```

### Pattern Array

Multiple patterns can be registered for a single application:

```typescript
router
  .host([".", "www.*"]) // Apex domains + www subdomain of any apex
  .map(() => import("./apps/main"));
```

## Cookie-Based Host Override

### Purpose

Allows developers to override the hostname used for routing by setting a cookie. This enables testing different applications (e.g., admin, API) on `localhost` without modifying `/etc/hosts` or DNS.

### Configuration

```typescript
const router = createHostRouter({
  hostOverride: {
    // Cookie name to read
    cookieName: "x-requested-host",

    // Only allow override on these hosts
    allowedHosts: ["localhost", "*.workers.dev"],

    // Optional: Additional validation logic
    validate: (request, cookieValue, context) => {
      // Custom validation
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cookieValue)) {
        throw new Error("Invalid hostname format");
      }
      return cookieValue;
    },
  },
});
```

### Behavior Flow

1. **Request arrives** with `x-requested-host` cookie
2. **Check current hostname** against `allowedHosts` patterns
   - If **NOT matched** → Throw error + delete cookie via `Set-Cookie: x-requested-host=; Max-Age=0`
   - If **matched** → Continue to step 3
3. **Call `validate()`** function (if provided)
   - If **throws** → Check for `.fallback()` handler
     - If `.fallback()` exists → Route to fallback with error in context
     - If no `.fallback()` → Error response + delete cookie
   - If **returns hostname** → Use returned hostname for matching
4. **Match using overridden hostname** against host patterns

### Important Notes

- `validate()` is **ONLY called** when:
  - Cookie exists AND
  - Current host matches one of the `allowedHosts` patterns
- If on non-allowed domain with cookie → immediate error (validate never called)
- Path is **never affected** - only hostname changes for matching

### Error Response

When override fails (non-allowed host or validation error):

```
Status: 400 Bad Request
Headers:
  Set-Cookie: x-requested-host=; Max-Age=0; Path=/; Secure; HttpOnly
  Content-Type: application/json
Body:
  {
    "error": "Host override not allowed on this domain",
    "message": "The x-requested-host cookie has been cleared"
  }
```

## Middleware

### Global Middleware

Runs for all hosts in registration order:

```typescript
router.use(async (request, context, next) => {
  console.log("Before:", request.url);
  const response = await next();
  console.log("After:", response.status);
  return response;
});
```

### Host-Specific Middleware

Runs only for matched host pattern:

```typescript
router
  .host(["admin.*"])
  .use(async (request, context, next) => {
    if (!context.user?.isAdmin) {
      return new Response("Unauthorized", { status: 401 });
    }
    return next();
  })
  .map(() => import("./apps/admin"));
```

### Middleware Signature

```typescript
type Middleware = (
  request: Request,
  context: any,
  next: () => Promise<Response>
) => Promise<Response>;
```

## Handler Functions

### Lazy Import

```typescript
router.host(["app.*"]).map(() => import("./apps/main"));
```

The imported module should export a default fetch handler or router.

### Direct Handler

```typescript
router.host(["health.*"]).map((request, context) => {
  return new Response("OK", { status: 200 });
});
```

### Handler Signature

```typescript
type Handler = (request: Request, context: any) => Response | Promise<Response>;
type LazyImport = () => Promise<{ default: Handler | Router }>;
```

## Examples

### Example 1: Basic Multi-App Setup

```typescript
import { createHostRouter } from "rsc-router/host";

const router = createHostRouter();

// Main application (apex + www subdomain)
router
  .host([".", "www.*"]) // example.com or www.example.com
  .map(() => import("./apps/main"));

// Admin panel (apex domains with /admin path)
router
  .host(["./admin"]) // example.com/admin/*
  .map(() => import("./apps/admin"));

// API subdomain
router
  .host(["api.*"]) // api.example.com
  .map(() => import("./apps/api"));

export default {
  fetch(request, env, ctx) {
    return router.match(request, { env, ctx });
  },
};
```

### Example 2: With Global Middleware

```typescript
const router = createHostRouter();

// Logging middleware
router.use(async (request, ctx, next) => {
  const start = Date.now();
  const response = await next();
  const duration = Date.now() - start;
  console.log(
    `${request.method} ${request.url} - ${response.status} (${duration}ms)`
  );
  return response;
});

// CORS middleware
router.use(async (request, ctx, next) => {
  const response = await next();
  response.headers.set("Access-Control-Allow-Origin", "*");
  return response;
});

router.host(["*"]).map(() => import("./apps/main"));
```

### Example 3: Host-Specific Middleware

```typescript
const router = createHostRouter();

// Admin requires authentication
router
  .host(["admin.*"])
  .use(async (request, ctx, next) => {
    const token = request.headers.get("Authorization");

    if (!token) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Validate token and inject user into context
    ctx.user = await validateToken(token);

    if (!ctx.user.isAdmin) {
      return new Response("Forbidden", { status: 403 });
    }

    return next();
  })
  .map(() => import("./apps/admin"));

// Public app (no auth required)
router
  .host(["."]) // Any apex domain
  .map(() => import("./apps/main"));
```

### Example 4: Cookie-Based Host Override (Simple)

```typescript
const router = createHostRouter({
  hostOverride: {
    cookieName: "x-requested-host",
    allowedHosts: ["localhost", "*.workers.dev", "*.pages.dev"],
  },
});

router.host(["admin.*"]).map(() => import("./apps/admin"));

router.host(["*"]).map(() => import("./apps/main"));

// Usage:
// 1. Set cookie: x-requested-host=admin.myapp.com
// 2. Visit http://localhost:3000
// 3. Routes to admin app instead of main app
```

### Example 5: Fallback Handler for Host Selection

```typescript
const router = createHostRouter({
  hostOverride: {
    cookieName: "x-requested-host",
    allowedHosts: ["localhost", "*.workers.dev"],

    validate: (request, cookieValue, context) => {
      if (!cookieValue) {
        throw new Error("No host selected");
      }

      // Validate the selected host
      const validHosts = ["admin.myapp.com", "app.myapp.com", "api.myapp.com"];
      if (!validHosts.includes(cookieValue)) {
        throw new Error(`Invalid host: ${cookieValue}`);
      }

      return cookieValue;
    },
  },
});

// Fallback handler shows host selector UI
router.fallback().map((request, context) => {
  // context.error contains the validation error
  console.log("Fallback triggered:", context.error.message);
  return import("./apps/host-selector");
});

// Regular routes
router.host(["admin.*"]).map(() => import("./apps/admin"));
router.host(["api.*"]).map(() => import("./apps/api"));
router.host(["*"]).map(() => import("./apps/main"));

// The host-selector app would render a UI to select/set the host cookie
```

### Example 6: Cookie Override with Custom Validation

```typescript
const router = createHostRouter({
  hostOverride: {
    cookieName: "x-requested-host",
    allowedHosts: ["localhost", "*.workers.dev"],

    validate: (request, cookieValue, context) => {
      // Only allow specific target hosts
      const allowedTargets = [
        "admin.myapp.com",
        "app.myapp.com",
        "api.myapp.com",
      ];

      if (!allowedTargets.includes(cookieValue)) {
        throw new Error(`Target host not allowed: ${cookieValue}`);
      }

      // Validate format
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cookieValue)) {
        throw new Error("Invalid hostname format");
      }

      return cookieValue;
    },
  },
});
```

### Example 6: Environment-Aware Validation

```typescript
const router = createHostRouter({
  hostOverride: {
    cookieName: "x-requested-host",
    allowedHosts: ["localhost", "*.workers.dev"],

    validate: (request, cookieValue, context) => {
      const isDev = context.env?.ENVIRONMENT === "development";

      if (!isDev) {
        // In production preview, be strict
        const allowedTargets = ["admin.myapp.com", "app.myapp.com"];
        if (!allowedTargets.includes(cookieValue)) {
          throw new Error("Target not allowed in production");
        }
      }

      return cookieValue;
    },
  },
});

export default {
  fetch(request, env, ctx) {
    return router.match(request, { env, ctx });
  },
};
```

### Example 7: SaaS Multi-Tenant

```typescript
const router = createHostRouter();

// Marketing site (apex + www)
router.host([".", "www.*"]).map(() => import("./apps/marketing"));

// Documentation subdomain
router.host(["docs.*"]).map(() => import("./apps/docs"));

// Admin subdomain
router
  .host(["admin.*"])
  .use(requireSuperAdmin())
  .map(() => import("./apps/admin"));

// Tenant applications (any single subdomain not matched above)
router
  .host(["*."]) // tenant.example.com
  .use(async (request, ctx, next) => {
    // Extract tenant from hostname
    const url = new URL(request.url);
    const tenant = url.hostname.split(".")[0];

    // Load tenant configuration
    ctx.tenant = await loadTenant(tenant);

    if (!ctx.tenant) {
      return new Response("Tenant not found", { status: 404 });
    }

    return next();
  })
  .map(() => import("./apps/saas-tenant"));
```

### Example 8: Direct Handler Functions

```typescript
const router = createHostRouter();

// Health check endpoint (no lazy loading needed)
router.host(["health.*"]).map((request, context) => {
  return new Response("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
});

// Status endpoint with context access
router.host(["status.*"]).map((request, context) => {
  const status = {
    environment: context.env.ENVIRONMENT,
    region: context.env.REGION,
    timestamp: Date.now(),
  };

  return new Response(JSON.stringify(status), {
    headers: { "Content-Type": "application/json" },
  });
});

// Main application (any apex domain)
router.host(["."]).map(() => import("./apps/main"));
```

### Example 9: Pattern Matching Priority

```typescript
const router = createHostRouter();

// More specific patterns should be registered first
router
  .host(["admin.example.com"]) // Exact match
  .map(() => import("./apps/admin"));

router
  .host(["api.*"]) // API subdomain of any apex
  .map(() => import("./apps/api"));

router
  .host(["./store"]) // Any apex with /store path
  .map(() => import("./apps/store"));

router
  .host(["*."]) // Any single subdomain (less specific)
  .map(() => import("./apps/saas"));

router
  .host(["."]) // Any apex domain (less specific)
  .map(() => import("./apps/main"));

router
  .host(["**"]) // Catch-all (least specific)
  .map(() => import("./apps/fallback"));

// Matching uses first-match-wins strategy
// Register from most specific to least specific
```

## API Reference

### TypeScript Signatures

```typescript
// Core types
interface HostRouter {
  host(patterns: string | string[]): HostRouteBuilder;
  use(...middleware: Middleware[]): HostRouter;
  match(request: Request, context?: any): Promise<Response>;
  fallback(): HostRouteBuilder;
  test(
    hostname: string
  ): { pattern: string; handler: Handler | LazyHandler } | null;
}

interface HostRouteBuilder {
  use(...middleware: Middleware[]): HostRouteBuilder;
  map(handler: Handler | LazyHandler): HostRouter;
}

// Handler types
type Handler = (request: Request, context: any) => Response | Promise<Response>;
type LazyHandler = () => Promise<{ default: Handler | Router }>;

// Middleware type
type Middleware = (
  request: Request,
  context: any,
  next: () => Promise<Response>
) => Promise<Response>;

// Factory function
function createHostRouter(options?: HostRouterOptions): HostRouter;

interface HostRouterOptions {
  debug?: boolean; // Enable debug logging
  hostOverride?: {
    cookieName: string;
    allowedHosts: string[];
    validate?: (request: Request, cookieValue: string, context: any) => string;
  };
}

// Type safety helper
function defineHosts<T extends Record<string, string | string[]>>(
  hosts: T
): Readonly<T>;

// Testing utilities
function createTestRequest(options: {
  host: string;
  path?: string;
  method?: string;
  cookies?: Record<string, string>;
}): Request;

function testPattern(pattern: string | string[], hostname: string): boolean;
```

## Pattern Matching Rules

### Order of Evaluation

1. Patterns are matched in the order they are registered (first match wins)
2. More specific patterns should be registered before less specific ones
3. Path patterns are normalized (trailing `/` removed) before matching

### Pattern Matching Table

| Pattern              | Description                        | Example Matches                                            | Example Non-Matches                        |
| -------------------- | ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| `.`                  | Any apex domain                    | `example.com`, `google.com`                                | `www.example.com`, `api.google.com`        |
| `*`                  | Any apex domain (same as `.`)      | `example.com`, `google.com`                                | `www.example.com`                          |
| `**`                 | Any domain (apex + subdomains)     | `example.com`, `www.example.com`, `a.b.c.example.com`      | -                                          |
| `*.`                 | Any single-level subdomain         | `www.example.com`, `api.google.com`                        | `example.com`, `a.b.example.com`           |
| `**.`                | Any multi-level subdomain          | `a.b.example.com`, `x.y.z.google.com`                      | `example.com`, `api.example.com`           |
| `example.com`        | Exact domain                       | `example.com`                                              | `www.example.com`, `example.net`           |
| `*.com`              | Any apex .com domain               | `google.com`, `example.com`                                | `google.net`, `www.google.com`             |
| `*.example.com`      | Single subdomain of example.com    | `api.example.com`, `www.example.com`                       | `example.com`, `a.b.example.com`           |
| `**.example.com`     | Any depth subdomain of example.com | `a.example.com`, `a.b.c.example.com`                       | `example.com`                              |
| `admin.*`            | Admin subdomain of any apex        | `admin.google.com`, `admin.example.com`                    | `admin.sub.example.com`                    |
| `admin.**`           | Admin subdomain of any domain      | `admin.example.com`, `admin.sub.example.com`               | `example.com`                              |
| `example.com/admin`  | Specific domain with path          | `example.com/admin`, `example.com/admin/users`             | `www.example.com/admin`, `example.com/api` |
| `api.example.com/v2` | Specific subdomain with path       | `api.example.com/v2/users`                                 | `api.example.com/v1`, `example.com/v2`     |
| `./admin`            | Any apex with /admin path          | `example.com/admin`, `google.com/admin/users`              | `www.example.com/admin`                    |
| `*./api`             | Any subdomain with /api path       | `api.example.com/api/v2`                                   | `example.com/api`                          |
| `admin./blog`        | Admin subdomain with /blog path    | `admin.example.com/blog/post-1`                            | `admin.example.com/api`                    |
| `**/dashboard`       | Any domain with /dashboard path    | `example.com/dashboard`, `app.example.com/dashboard/stats` | `example.com/admin`                        |

### Registration Order Example

```typescript
// Register from most specific to least specific
router.host(['admin.example.com/api']).map(...);  // Exact domain + path
router.host(['google.com/admin']).map(...);       // Specific apex + path
router.host(['admin.*/api']).map(...);            // Pattern domain + path
router.host(['admin.*']).map(...);                // Pattern domain
router.host(['*./api']).map(...);                 // Any subdomain + path
router.host(['*.']).map(...);                     // Any subdomain
router.host(['./api']).map(...);                  // Any apex + path
router.host(['.']).map(...);                      // Any apex
router.host(['**']).map(...);                     // Catch-all
```

### Pattern Validation

Patterns are validated at registration time. Invalid patterns will throw an error:

```typescript
router.host(["invalid pattern with spaces"]); // ❌ Throws error
router.host(["admin.*"]); // ✅ Valid
router.host(["*."]); // ✅ Valid
router.host(["./api"]); // ✅ Valid
router.host(["**"]); // ✅ Valid
```

## Cookie Override Use Cases

### Development Workflow

```bash
# Test admin panel on localhost
curl -H "Cookie: x-requested-host=admin.myapp.com" http://localhost:3000

# Test API endpoints
curl -H "Cookie: x-requested-host=api.myapp.com" http://localhost:3000

# Test specific tenant
curl -H "Cookie: x-requested-host=acme.myapp.com" http://localhost:3000
```

### Browser DevTools

```javascript
// Set cookie in browser console
document.cookie = "x-requested-host=admin.myapp.com; path=/";

// Reload page - now routes to admin app

// Clear cookie
document.cookie = "x-requested-host=; path=/; max-age=0";
```

### Preview Deployments

Workers.dev and Pages.dev deployments can use cookie override to test production-like routing:

```typescript
const router = createHostRouter({
  hostOverride: {
    cookieName: "x-requested-host",
    allowedHosts: ["*.workers.dev", "*.pages.dev"],
  },
});

// Visit: https://my-app-abc123.workers.dev
// With cookie: x-requested-host=admin.myapp.com
// Routes as if visiting: admin.myapp.com
```

## Best Practices

### 1. Order Patterns by Specificity

```typescript
// ✅ Good: Most specific first
router.host(["admin.example.com"]).map(() => import("./apps/admin"));
router.host(["api.*"]).map(() => import("./apps/api"));
router.host(["*."]).map(() => import("./apps/tenant"));
router.host(["."]).map(() => import("./apps/main"));

// ❌ Bad: Catch-all first (nothing else will match)
router.host(["**"]).map(() => import("./apps/main"));
router.host(["admin.*"]).map(() => import("./apps/admin")); // Never reached
```

### 2. Use Host-Specific Middleware

```typescript
// ✅ Good: Auth only on admin
router
  .host(["admin.*"])
  .use(requireAuth())
  .map(() => import("./apps/admin"));

// ❌ Bad: Auth on everything
router.use(requireAuth()); // Blocks public pages too
```

### 3. Validate Cookie Override Targets

```typescript
// ✅ Good: Explicit allowlist
validate: (request, cookieValue, context) => {
  const allowed = ["admin.myapp.com", "api.myapp.com"];
  if (!allowed.includes(cookieValue)) {
    throw new Error("Not allowed");
  }
  return cookieValue;
};

// ❌ Bad: Accept any hostname
validate: (request, cookieValue) => cookieValue;
```

### 4. Use Lazy Imports

```typescript
// ✅ Good: Lazy load apps
router.host(["admin.*"]).map(() => import("./apps/admin"));

// ❌ Bad: Eager load everything
import adminApp from "./apps/admin";
router.host(["admin.*"]).map(() => adminApp);
```

### 5. Handle Errors Gracefully

```typescript
router.use(async (request, ctx, next) => {
  try {
    return await next();
  } catch (error) {
    console.error("Router error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
});
```

## Comparison with Path Router

| Feature         | Host Router                | Path Router (RSCRouter)   |
| --------------- | -------------------------- | ------------------------- |
| Matches on      | Hostname/domain            | URL pathname              |
| Use case        | Multi-app hosting          | Single-app routing        |
| Pattern syntax  | `admin.*`, `./store`, `*.` | `/blog/:slug`, `/admin/*` |
| Middleware      | Host-level                 | Route-level               |
| Lazy loading    | Per application            | Per route                 |
| Cookie override | Yes (for dev)              | N/A                       |

### When to Use Host Router

- Multi-tenant SaaS applications
- Microservices on subdomains
- Separate admin/api/app domains
- Testing different apps locally

### When to Use Path Router

- Single application with many routes
- RESTful APIs
- Traditional web applications
- Route-level code splitting

### Using Both Together

```typescript
// Host router delegates to path routers
const hostRouter = createHostRouter();

// Main app path router (apex + www)
hostRouter.host([".", "www.*"]).map(() => import("./routers/main-router"));

// Admin subdomain path router
hostRouter
  .host(["admin.*"])
  .use(requireAuth())
  .map(() => import("./routers/admin-router"));

// Each imported router is a full RSCRouter with its own routes
```

## Type Safety

### `defineHosts()`

Helper function for type-safe host pattern definitions.

```typescript
import { defineHosts } from "rsc-router/host";

const hosts = defineHosts({
  admin: "admin.*",
  api: "api.*",
  docs: "docs.*",
  app: ["*", "www.*"],
  tenant: ["*.*"],
});

// Type-safe usage with autocomplete
router.host(hosts.admin).map(() => import("./apps/admin"));
router.host(hosts.api).map(() => import("./apps/api"));

// TypeScript error on typo
router.host(hosts.adnim); // ❌ Property 'adnim' does not exist
```

Benefits:

- Central source of truth for all host patterns
- Type-safe references throughout codebase
- Easy refactoring and testing
- Autocomplete in IDEs

## Testing Utilities

### `createTestRequest()`

Helper for creating test requests with specific hosts and cookies.

```typescript
import { createTestRequest, testPattern } from "rsc-router/host/testing";

const request = createTestRequest({
  host: "admin.example.com",
  path: "/dashboard",
  method: "GET",
  cookies: {
    "x-requested-host": "api.example.com",
  },
});

// Use with actual router
const response = await router.match(request);
```

### `testPattern()`

Utility for testing pattern matching without requests.

```typescript
import { testPattern } from "rsc-router/host/testing";

// Test single patterns
expect(testPattern("admin.*", "admin.example.com")).toBe(true);
expect(testPattern("*/api", "example.com/api/users")).toBe(true);

// Test pattern arrays
expect(testPattern(["*", "www.*"], "example.com")).toBe(true);
```

## Debug Mode

Enable debug logging to see pattern matching decisions.

```typescript
const router = createHostRouter({
  debug: true,  // Enable debug logging
  hostOverride: { ... }
});

// Debug output:
// [HostRouter] Request: admin.example.com/dashboard
// [HostRouter] Checking pattern: "admin.*" ✓ MATCH
// [HostRouter] Using handler: () => import('./apps/admin')
// [HostRouter] Cookie override: x-requested-host=api.example.com
// [HostRouter] Validated to: api.example.com
```

## Implementation Notes

### Performance Considerations

1. **Lazy Loading**: Applications are only loaded when their host pattern matches
2. **Pattern Caching**: Compiled patterns are cached for fast matching
3. **Middleware Chain**: Middleware runs in order until a response is returned
4. **First Match Wins**: Stops evaluation after first pattern match

### Security Considerations

1. **Cookie Override**: Only enabled for allowed hosts to prevent abuse
2. **Cookie Deletion**: Invalid override attempts clear the cookie
3. **Validate Function**: Additional security layer for custom validation
4. **HTTPS Cookies**: Cookies should be Secure and HttpOnly in production

### Error Handling

All errors during routing result in:

- Appropriate HTTP status code (400, 401, 403, 500)
- Cookie deletion if override-related
- JSON error response body
- Logged errors for debugging

## Future Enhancements

Potential features for consideration:

- **Hostname Rewriting**: Transform hostname before matching
- **Performance Metrics**: Optional timing and analytics

---

**Version**: 1.0.0
**Status**: Design Phase
**Last Updated**: 2025-11-12
