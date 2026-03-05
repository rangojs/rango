---
name: middleware
description: Define middleware for authentication, logging, and request processing in @rangojs/router
argument-hint: [middleware-name]
---

# Middleware

Middleware runs before/after route handlers using the onion model.

## Execution Model

Canonical semantics reference:
[docs/execution-model.md](../../docs/internal/execution-model.md)

There are two levels of middleware with different execution scopes:

### Global middleware (`router.use()`)

Registered on the router instance. Wraps the **entire request**, including server actions, rendering, and progressive enhancement (PE) re-renders.

```typescript
const router = createRouter<AppEnv>({})
  .use(loggerMiddleware) // all routes
  .use("/admin/*", authMiddleware) // pattern-scoped
  .routes(urlpatterns);
```

### Route middleware (`middleware()` in `urls()`)

Registered inside `urls()` callback. Wraps **rendering only** -- it does NOT wrap server action execution. Actions run before route middleware, so when route middleware executes during post-action revalidation, it can observe state that the action set (cookies, context variables, headers).

```
Request flow (with action):
  global mw -> action executes -> route mw -> layout -> handler -> loaders

Request flow (no action):
  global mw -> route mw -> layout -> handler -> loaders

Progressive enhancement (no-JS form POST):
  global mw -> action executes -> route mw -> full page re-render
```

The contract is: **route middleware wraps rendering regardless of transport** (JS-enabled RSC stream or no-JS HTML). During PE re-render, route middleware observes action-set state (cookies, context variables) the same way it does during JS-enabled post-action revalidation.

Revalidation is still partial. Route middleware wraps the render pass that
does happen, but it does not force unrelated outer segments to recompute.
If a child segment depends on data established by an outer handler/layout,
revalidate that outer segment too, or have the child guard/reload the
data itself.

### Revalidation Contracts with Middleware-Backed Trees

Middleware can establish request-level context (`ctx.set`) for segments that
execute in the current render pass. It does not change partial revalidation
boundaries between handler/layout/parallel segments.

For shared segment data, use named revalidation contracts on both the producer
and consumer segments, even when middleware is present in the chain.

```typescript
export const revalidateCartData = ({ actionId }) =>
  actionId?.includes("src/actions/cart.ts#") ?? false;

layout(CartLayout, () => [
  middleware(cartRenderMiddleware),
  revalidate(revalidateCartData), // producer reruns
  parallel(
    { "@cart": CartSummary },
    () => [revalidate(revalidateCartData)], // consumer reruns
  ),
]);
```

You can package those contracts as importable helpers to avoid repeating
`revalidate(...)` at each segment:

```typescript
import { revalidate } from "@rangojs/router";

export const revalidateCart = () => [
  revalidate(revalidateCartData),
];

layout(CartLayout, () => [
  middleware(cartRenderMiddleware),
  revalidateCart(),
  parallel(
    { "@cart": CartSummary },
    () => [revalidateCart()],
  ),
]);
```

Route middleware is the right place for per-route concerns that affect rendering (setting context variables for handlers, adding response headers, reading cookies set by actions). It is NOT the right place for action guards -- use global middleware for that.

## Basic Middleware

```typescript
import type { Middleware } from "@rangojs/router";

export const authMiddleware: Middleware = async (ctx, next) => {
  const token = ctx.request.headers.get("Authorization");

  if (!token) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const user = await verifyToken(token);
  ctx.set("user", user);

  await next();
};
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
export const myMiddleware: Middleware = async (ctx, next) => {
  // Access request
  ctx.request; // Request object
  ctx.url; // Parsed URL
  ctx.params; // Route parameters

  // Access platform bindings (plain bindings from createRouter<TEnv>())
  ctx.env.DB; // D1Database
  ctx.env.KV; // KVNamespace

  // Set variables for downstream handlers (typed via RSCRouter.Vars)
  ctx.set("user", { id: "123", name: "John" });

  // Continue to next middleware/handler
  await next();

  // After handler (response intercepting)
  console.log("Handler completed");
};
```

### Typed context variables in middleware

Use `createVar<T>()` for type-safe data sharing between middleware and handlers:

```typescript
import { createVar } from "@rangojs/router";
import type { Middleware } from "@rangojs/router";

interface AuthUser { id: string; email: string; role: string }
export const CurrentUser = createVar<AuthUser>();

export const authMiddleware: Middleware = async (ctx, next) => {
  const token = ctx.request.headers.get("Authorization");
  if (!token) throw new Response("Unauthorized", { status: 401 });

  const user = await verifyToken(token);
  ctx.set(CurrentUser, user);  // type-checked
  await next();
};

// In a handler -- typed read
import { CurrentUser } from "./middleware";

const Dashboard: Handler<"dashboard"> = (ctx) => {
  const user = ctx.get(CurrentUser);  // typed as AuthUser | undefined
  return <DashboardPage user={user!} />;
};
```

This works alongside `ctx.get("key")` / `ctx.set("key", value)` (global typing
via RSCRouter.Vars augmentation). Use `createVar` for route-local or feature-scoped
data; use RSCRouter.Vars for app-wide middleware state.

## Redirect with State in Middleware

```typescript
import { redirect, createLocationState } from "@rangojs/router";
import type { Middleware } from "@rangojs/router";

export const FlashMessage = createLocationState<{ text: string }>({
  flash: true,
});

export const requireAuthMiddleware: Middleware = async (ctx, next) => {
  const token = ctx.request.headers.get("Authorization");
  if (!token) {
    return redirect("/login", {
      state: [FlashMessage({ text: "Please log in to continue" })],
    });
  }
  await next();
};
```

Read the flash on the target page with `useLocationState(FlashMessage)`. The `{ flash: true }` option makes it auto-clear after first render. See `/hooks`.

## Authentication Middleware

```typescript
export const requireAuthMiddleware: Middleware = async (ctx, next) => {
  const user = ctx.get("user");

  if (!user) {
    throw new Response("Unauthorized", { status: 401 });
  }

  await next();
};

export const permissionsMiddleware: Middleware = async (ctx, next) => {
  const user = ctx.get("user");
  const requiredPermission = "admin";

  if (!user?.permissions?.includes(requiredPermission)) {
    throw new Response("Forbidden", { status: 403 });
  }

  await next();
};
```

## Logger Middleware

```typescript
export const loggerMiddleware: Middleware = async (ctx, next) => {
  const start = Date.now();

  console.log(`[${ctx.request.method}] ${ctx.url.pathname}`);

  await next();

  const duration = Date.now() - start;
  console.log(`[${ctx.request.method}] ${ctx.url.pathname} - ${duration}ms`);
};
```

## Rate Limiting Middleware

```typescript
export const rateLimitMiddleware: Middleware = async (ctx, next) => {
  const ip = ctx.request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = `rate-limit:${ip}`;

  const count = await ctx.env.KV.get(key);
  const requests = count ? parseInt(count) : 0;

  if (requests > 100) {
    throw new Response("Too Many Requests", { status: 429 });
  }

  await ctx.env.KV.put(key, String(requests + 1), {
    expirationTtl: 60,
  });

  await next();
};
```

## Complete Example

```typescript
// middleware/index.ts
import type { Middleware } from "@rangojs/router";

export const loggerMiddleware: Middleware = async (ctx, next) => {
  console.log(`[${ctx.request.method}] ${ctx.url.pathname}`);
  await next();
};

export const mockAuthMiddleware: Middleware = async (ctx, next) => {
  // Mock user for development
  ctx.set("user", { id: "1", name: "Demo User" });
  await next();
};

export const requireAuthMiddleware: Middleware = async (ctx, next) => {
  if (!ctx.get("user")) {
    throw new Response("Unauthorized", { status: 401 });
  }
  await next();
};

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
