---
name: host-router
description: Multi-app host routing with domain/subdomain patterns
argument-hint:
---

# Host Router

Route requests to different apps based on domain, subdomain, or path prefix patterns. Supports middleware, lazy loading, cookie-based host override for dev, and a fallback handler.

## Import

```typescript
import { createHostRouter, defineHosts } from "@rangojs/router/host";
```

## Basic Setup

```typescript
// host-router.ts
import { createHostRouter } from "@rangojs/router/host";

const router = createHostRouter();

router.host(["."]).map(() => import("./apps/main"));
router.host(["admin.*"]).map(() => import("./apps/admin"));
router.host(["api.*"]).map(() => import("./apps/api"));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.match(request, { env, ctx });
  },
};
```

Each `.map()` receives either a direct handler `(request, input) => Response` or a lazy import `() => import(...)`. Lazy imports resolve a module with a `default` export that is either a handler function or another `HostRouter` (for nesting).

## Pattern Syntax

| Pattern            | Matches                                        |
| ------------------ | ---------------------------------------------- |
| `.` or `*`         | Any apex domain (`example.com`)                |
| `**`               | Any domain (apex + all subdomains)             |
| `*.`               | Any single-level subdomain (`www.example.com`) |
| `**. `             | Any multi-level subdomain (`a.b.example.com`)  |
| `example.com`      | Exact domain                                   |
| `*.com`            | Any apex `.com` domain                         |
| `*.example.com`    | Single subdomain of `example.com`              |
| `**.example.com`   | Any depth subdomain of `example.com`           |
| `admin.*`          | `admin` subdomain of any apex domain           |
| `admin.**`         | `admin` subdomain of any domain                |
| `admin.`           | `admin` subdomain of any apex (no wildcard)    |
| `example.com/api`  | Domain + path prefix (prefix match)            |

Patterns are tested in registration order. First match wins.

## `defineHosts` for Type Safety

```typescript
import { defineHosts } from "@rangojs/router/host";

const hosts = defineHosts({
  admin: "admin.*",
  api: "api.*",
  app: [".", "www.*"],
});

router.host(hosts.admin).map(() => import("./apps/admin"));
router.host(hosts.app).map(() => import("./apps/main"));
```

Returns a frozen object — keys are autocompleted by TypeScript.

## Middleware

Global middleware runs for every matched route. Per-route middleware runs only for that host pattern.

```typescript
const router = createHostRouter();

// Global — runs for all routes
router.use(async (request, input, next) => {
  console.log(`[${new Date().toISOString()}] ${request.url}`);
  return next();
});

// Per-route
router
  .host(["admin.*"])
  .use(requireAuth)
  .map(() => import("./apps/admin"));
```

Middleware signature: `(request: Request, input: RouterRequestInput, next: () => Promise<Response>) => Promise<Response>`

Calling `next()` more than once throws.

## Fallback Handler

Handles cookie-override errors when `hostOverride` is configured (e.g., override from a disallowed host, invalid cookie hostname). The fallback does **not** catch unmatched hosts — those throw `NoRouteMatchError`. Catch that at the worker level if you need a 404.

```typescript
const router = createHostRouter({
  hostOverride: { cookieName: "x-dev-host", allowedHosts: ["localhost"] },
});

// Called when cookie override fails (not for general unmatched hosts)
router.fallback().map((request) => {
  return new Response("Invalid host override", { status: 400 });
});
```

For unmatched hosts without `hostOverride`, catch `NoRouteMatchError` in your worker fetch:

```typescript
import { NoRouteMatchError } from "@rangojs/router/host";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return await router.match(request, { env, ctx });
    } catch (err) {
      if (err instanceof NoRouteMatchError) {
        return new Response("Not Found", { status: 404 });
      }
      throw err;
    }
  },
};
```

## Cookie-Based Host Override

For development: route requests to a different app based on a cookie value, allowing developers to test different host routes from a single domain.

```typescript
const router = createHostRouter({
  hostOverride: {
    cookieName: "x-dev-host",
    allowedHosts: ["localhost", "**.dev.example.com"],
    validate: (request, cookieValue, input) => {
      // Optional custom validation — return the effective hostname
      return cookieValue;
    },
  },
});
```

When a request arrives:
1. If no cookie → use actual hostname
2. If cookie present and host is in `allowedHosts` → use cookie value as hostname
3. If cookie present but host not allowed → throw `HostOverrideNotAllowedError`

Without a custom `validate`, the cookie value is validated as a hostname via `new URL()`.

## Debug Mode

```typescript
const router = createHostRouter({ debug: true });
```

Logs pattern matching, route registration, and cookie override decisions to console.

## Testing

```typescript
import { createTestRequest, testPattern } from "@rangojs/router/host/testing";

// Test pattern matching
testPattern("admin.*", "admin.example.com"); // true
testPattern([".", "www.*"], "example.com"); // true

// Create requests for integration tests
const request = createTestRequest({
  host: "admin.example.com",
  path: "/dashboard",
  cookies: { "x-dev-host": "api.example.com" },
});

// Test which route would match (without executing)
router.test("admin.example.com"); // { pattern, handler } | null
```

## Error Types

All errors extend `HostRouterError`:

| Error                        | When                                        |
| ---------------------------- | ------------------------------------------- |
| `InvalidPatternError`        | Pattern is empty, non-string, or has spaces |
| `HostOverrideNotAllowedError`| Cookie override from disallowed host        |
| `InvalidHostnameError`       | Cookie value isn't a valid hostname         |
| `HostValidationError`        | Custom `validate` function threw            |
| `NoRouteMatchError`          | No host pattern matched the request         |
| `InvalidHandlerError`        | Handler is not a function                   |

See the fallback section above for a `NoRouteMatchError` catch example.

## Nesting Host Routers

A lazy handler can resolve to another `HostRouter`:

```typescript
// apps/regional.ts
import { createHostRouter } from "@rangojs/router/host";

const regional = createHostRouter();
regional.host(["us.*"]).map(() => import("./regions/us"));
regional.host(["eu.*"]).map(() => import("./regions/eu"));

export default regional;
```

```typescript
// host-router.ts
router.host(["**.regional.example.com"]).map(() => import("./apps/regional"));
```
