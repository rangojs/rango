---
name: middleware
description: Define middleware for authentication, logging, and request processing in @rangojs/router
argument-hint: [middleware-name]
---

# Middleware

Middleware runs before/after route handlers using the onion model.

## Basic Middleware

```typescript
import { createMiddleware } from "@rangojs/router";

export const authMiddleware = createMiddleware(async (ctx, next) => {
  const token = ctx.request.headers.get("Authorization");

  if (!token) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const user = await verifyToken(token);
  ctx.env.Variables.user = user;

  await next();
});
```

## Using Middleware in Routes

```typescript
import { urls } from "@rangojs/router";
import { authMiddleware, loggerMiddleware } from "./middleware";

export const urlpatterns = urls(({ path, layout, middleware }) => [
  // Global middleware for all routes in this file
  middleware(loggerMiddleware),

  // Layout with scoped middleware
  layout(<AdminLayout />, () => [
    middleware(authMiddleware),  // Only for admin routes

    path("/admin", AdminDashboard, { name: "admin.index" }),
    path("/admin/users", AdminUsers, { name: "admin.users" }),
  ]),

  // Public routes (no auth middleware)
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),
]);
```

## Middleware with Multiple Handlers

```typescript
// Spread multiple middleware from a single export
export const shopMiddleware = [loggerMiddleware, mockAuthMiddleware];

// In routes
layout(<ShopLayout />, () => [
  middleware(...shopMiddleware),

  path("/shop", ShopIndex, { name: "shop" }),
])
```

## Middleware Context

```typescript
export const myMiddleware = createMiddleware(async (ctx, next) => {
  // Access request
  ctx.request;              // Request object
  ctx.url;                  // Parsed URL
  ctx.params;               // Route parameters

  // Access environment
  ctx.env.Bindings.DB;      // Cloudflare bindings
  ctx.env.Variables;        // Mutable variables

  // Set variables for downstream handlers
  ctx.env.Variables.user = { id: "123", name: "John" };

  // Continue to next middleware/handler
  await next();

  // After handler (response intercepting)
  console.log("Handler completed");
});
```

## Authentication Middleware

```typescript
export const requireAuthMiddleware = createMiddleware(async (ctx, next) => {
  const user = ctx.env.Variables.user;

  if (!user) {
    throw new Response("Unauthorized", { status: 401 });
  }

  await next();
});

export const permissionsMiddleware = createMiddleware(async (ctx, next) => {
  const user = ctx.env.Variables.user;
  const requiredPermission = "admin";

  if (!user?.permissions?.includes(requiredPermission)) {
    throw new Response("Forbidden", { status: 403 });
  }

  await next();
});
```

## Logger Middleware

```typescript
export const loggerMiddleware = createMiddleware(async (ctx, next) => {
  const start = Date.now();

  console.log(`[${ctx.request.method}] ${ctx.url.pathname}`);

  await next();

  const duration = Date.now() - start;
  console.log(`[${ctx.request.method}] ${ctx.url.pathname} - ${duration}ms`);
});
```

## Rate Limiting Middleware

```typescript
export const rateLimitMiddleware = createMiddleware(async (ctx, next) => {
  const ip = ctx.request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = `rate-limit:${ip}`;

  const count = await ctx.env.Bindings.KV.get(key);
  const requests = count ? parseInt(count) : 0;

  if (requests > 100) {
    throw new Response("Too Many Requests", { status: 429 });
  }

  await ctx.env.Bindings.KV.put(key, String(requests + 1), {
    expirationTtl: 60,
  });

  await next();
});
```

## Complete Example

```typescript
// middleware/index.ts
import { createMiddleware } from "@rangojs/router";

export const loggerMiddleware = createMiddleware(async (ctx, next) => {
  console.log(`[${ctx.request.method}] ${ctx.url.pathname}`);
  await next();
});

export const mockAuthMiddleware = createMiddleware(async (ctx, next) => {
  // Mock user for development
  ctx.env.Variables.user = { id: "1", name: "Demo User" };
  await next();
});

export const requireAuthMiddleware = createMiddleware(async (ctx, next) => {
  if (!ctx.env.Variables.user) {
    throw new Response("Unauthorized", { status: 401 });
  }
  await next();
});

// urls.tsx
import { urls } from "@rangojs/router";
import {
  loggerMiddleware,
  mockAuthMiddleware,
  requireAuthMiddleware,
} from "./middleware";

export const urlpatterns = urls(({ path, layout, middleware }) => [
  // Global middleware
  middleware(loggerMiddleware),
  middleware(mockAuthMiddleware),

  // Public routes
  path("/", HomePage, { name: "home" }),

  // Protected routes
  layout(<AccountLayout />, () => [
    middleware(requireAuthMiddleware),

    path("/account", AccountPage, { name: "account" }),
    path("/account/settings", SettingsPage, { name: "settings" }),
  ]),
]);
```
