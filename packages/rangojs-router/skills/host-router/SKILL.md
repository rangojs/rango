---
name: host-router
description: Multi-app host routing with domain/subdomain patterns and cookie-based host override
argument-hint: [pattern]
---

# Host Router

Route requests to different apps based on domain/subdomain patterns. Supports cookie-based host override for local development.

## Import

```typescript
import { createHostRouter } from "@rangojs/router/host";
```

## Pattern Reference

| Pattern | Matches | Example |
|---------|---------|---------|
| `.` | Apex domain (2 parts) | `example.com` |
| `*` | Apex domain (2 parts) | `example.com` |
| `**` | Any domain | `example.com`, `sub.example.com` |
| `*.` | Single subdomain | `www.example.com` |
| `**.` | Multi-level subdomains (2+) | `a.b.example.com` |
| `admin.*` | Specific subdomain of any apex | `admin.example.com` |
| `admin.**` | Specific subdomain of any depth | `admin.sub.example.com` |
| `*.example.com` | Single subdomain of specific domain | `api.example.com` |
| `**.example.com` | Any depth subdomain of specific domain | `a.b.example.com` |
| `./admin` | Apex domain with path prefix | `example.com/admin` |
| `*./api` | Single subdomain with path prefix | `api.example.com/api` |
| `admin./blog` | Specific subdomain with path prefix | `admin.example.com/blog` |
| `**/health` | Any domain with path prefix | `*.example.com/health` |
| `localhost` | Exact match | `localhost` |

Path patterns match the prefix and all sub-paths (e.g., `./admin` matches `/admin`, `/admin/users`, etc.).

## Basic Setup

```typescript
// worker.ts
import { createHostRouter } from "@rangojs/router/host";

const router = createHostRouter();

router.host(["admin.*"]).map(() => import("./apps/admin"));
router.host(["api.*"]).map(() => import("./apps/api"));
router.host(["."]).map(() => import("./apps/main"));

export default {
  fetch(request: Request) {
    return router.match(request);
  },
};
```

## Middleware

```typescript
// Global middleware (runs for all hosts)
router.use(async (request, context, next) => {
  context.startTime = Date.now();
  const response = await next();
  return response;
});

// Host-specific middleware
router
  .host(["admin.*"])
  .use(async (request, context, next) => {
    const token = request.headers.get("Authorization");
    if (!token) return new Response("Unauthorized", { status: 401 });
    return next();
  })
  .map(adminHandler);
```

## Cookie-Based Host Override

Enables local development of multi-host apps on a single hostname (e.g., `localhost`).

```typescript
const router = createHostRouter({
  hostOverride: {
    cookieName: "x-requested-host",
    allowedHosts: ["localhost", "127.0.0.1"],
  },
});

// With custom validation
const router = createHostRouter({
  hostOverride: {
    cookieName: "x-requested-host",
    allowedHosts: ["localhost"],
    validate: (request, cookieValue, context) => {
      // Return the hostname to use, or throw to trigger fallback
      if (!isValidHost(cookieValue)) {
        throw new Error("Invalid host");
      }
      return cookieValue;
    },
  },
});
```

## Fallback Handler

Handles failed cookie overrides (invalid hostname, validation errors).

```typescript
router.fallback().map((request, context) => {
  // context.error contains the HostRouterError
  return new Response(
    JSON.stringify({ error: context.error?.message }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
});
```

## Lazy Imports

Handlers can return dynamic imports for code splitting.

```typescript
// The default export can be a handler function or another HostRouter
router.host(["admin.*"]).map(() => import("./apps/admin"));
```

## defineHosts Utility

Type-safe host definitions for reuse across your app.

```typescript
import { defineHosts } from "@rangojs/router/host";

const hosts = defineHosts({
  admin: "admin.*",
  api: "api.*",
  app: [".", "www.*"],
});

router.host([hosts.admin]).map(adminHandler);
router.host([hosts.api]).map(apiHandler);
router.host(hosts.app).map(mainHandler);
```

## Testing

```typescript
import { createTestRequest, testPattern } from "@rangojs/router/host/testing";

// Create test requests with host, path, cookies
const request = createTestRequest({
  host: "admin.example.com",
  path: "/dashboard",
  cookies: { "x-requested-host": "api.example.com" },
});

// Test pattern matching
testPattern("admin.*", "admin.example.com"); // true
testPattern([".", "www.*"], "www.example.com"); // true
```

## router.test()

Test which pattern would match a hostname without executing handlers.

```typescript
const result = router.test("admin.example.com");
// { pattern: "admin.*", handler: [Function] } or null
```

## Error Classes

All errors extend `HostRouterError`:

- `InvalidPatternError` - Invalid host pattern syntax
- `HostOverrideNotAllowedError` - Cookie override on disallowed host
- `InvalidHostnameError` - Cookie value is not a valid hostname
- `HostValidationError` - Custom validation function threw
- `NoRouteMatchError` - No pattern matched the request
- `InvalidHandlerError` - Handler is not a function

```typescript
import { NoRouteMatchError } from "@rangojs/router/host";

try {
  await router.match(request);
} catch (error) {
  if (error instanceof NoRouteMatchError) {
    return new Response("Not Found", { status: 404 });
  }
}
```

## Complete Multi-App Example

```typescript
import { createHostRouter, defineHosts } from "@rangojs/router/host";

const hosts = defineHosts({
  admin: "admin.*",
  api: "api.*",
  docs: "docs.*",
  blog: "./blog",
  main: [".", "www.*"],
});

const router = createHostRouter({
  debug: process.env.NODE_ENV === "development",
  hostOverride: {
    cookieName: "x-requested-host",
    allowedHosts: ["localhost"],
  },
});

// Global middleware
router.use(async (req, ctx, next) => {
  ctx.requestId = crypto.randomUUID();
  return next();
});

// Fallback for invalid cookie overrides
router.fallback().map((req, ctx) =>
  new Response(JSON.stringify({ error: ctx.error?.message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  })
);

// Route to apps (lazy loaded)
router.host([hosts.admin]).map(() => import("./apps/admin"));
router.host([hosts.api]).map(() => import("./apps/api"));
router.host([hosts.docs]).map(() => import("./apps/docs"));
router.host([hosts.blog]).map(() => import("./apps/blog"));
router.host(hosts.main).map(() => import("./apps/main"));
router.host(["**"]).map(() => new Response("Not Found", { status: 404 }));

export default {
  fetch(request: Request) {
    return router.match(request);
  },
};
```
