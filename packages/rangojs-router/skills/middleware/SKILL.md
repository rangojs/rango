---
name: middleware
description: Define middleware for authentication, logging, and request processing in @rangojs/router. Use when gating routes behind auth checks, logging requests, or running shared logic before a handler runs.
argument-hint: [middleware-name]
---

# Middleware

Middleware runs before/after route handlers using the onion model.

## Execution Model

There are two levels of middleware with different execution scopes:

### Global middleware (`router.use()`)

Registered on the router instance. Wraps the **entire request**, including server actions, rendering, and progressive enhancement (PE) re-renders.

```typescript
const router = createRouter<AppEnv>({})
  .use(loggerMiddleware) // all routes
  .use("/admin/*", authMiddleware) // pattern-scoped
  .routes(urlpatterns);
```

When the router has a `basename`, pattern-scoped `.use()` patterns are automatically prefixed. For example, with `basename: "/app"`, `.use("/admin/*", mw)` matches `/app/admin/*`.

### Route middleware (`middleware()` in `urls()`)

Registered inside `urls()` callback. Wraps **rendering only** -- it does NOT wrap server action execution. Actions run before route middleware, so when route middleware executes during post-action revalidation, it can observe state that the action set (cookies, context variables, headers).

> **Implication for auth:** route middleware cannot guard server actions. Use `router.use("/admin/*", requireAuth)` (global, scoped) for action protection, or check inside the action body. See `/server-actions` for action-side auth patterns.

```
Request flow (with action):
  global mw -> action executes -> route mw -> render pass

Request flow (no action):
  global mw -> route mw -> render pass

Progressive enhancement (no-JS form POST):
  global mw -> action executes -> route mw -> full page re-render
```

The **render pass** resolves handler, layouts, parallels, and loaders together —
it is not a handler-then-loaders sequence. Handler-first ordering is guaranteed
only between a route handler and its child/orphan layouts and parallels (so
`ctx.set` is visible); loaders run **concurrently** and stream their results, so
their latency overlaps rendering rather than blocking it. See `/loader` →
"Parallel and streaming".

The contract is: **route middleware wraps rendering regardless of transport** (JS-enabled RSC stream or no-JS HTML). During PE re-render, route middleware observes action-set state (cookies, context variables) the same way it does during JS-enabled post-action revalidation.

Revalidation is still partial. Route middleware wraps the render pass that
does happen, but it does not force unrelated outer segments to recompute.
If a child segment depends on data established by an outer handler/layout,
revalidate that outer segment too, or have the child guard/reload the
data itself.

### Revalidation Contracts with Middleware-Backed Trees

Middleware can establish request-level context (`ctx.set`) for segments that
execute in the current render pass. Because route middleware wraps **every**
render pass — normal renders, post-action revalidation, PE re-renders — its
variables are never stale: middleware is the safest `ctx.set` rung on the
data-passing ladder (`/rango` → "Passing data down the tree"). But it does
not change partial revalidation boundaries between handler/layout/parallel
segments.

For shared segment data, use named revalidation contracts on both the producer
and consumer segments, even when middleware is present in the chain.

```typescript
import * as CartActions from "./actions/cart";

export const revalidateCartData = (ctx) =>
  ctx.isAction(CartActions) || undefined;

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

export const revalidateCart = () => [revalidate(revalidateCartData)];

layout(CartLayout, () => [
  middleware(cartRenderMiddleware),
  revalidateCart(),
  parallel({ "@cart": CartSummary }, () => [revalidateCart()]),
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
// Group multiple middleware in an array
export const shopMiddleware = [loggerMiddleware, mockAuthMiddleware];

// In routes — pass the array directly
layout(<ShopLayout />, () => [
  middleware(shopMiddleware),

  path("/shop", ShopIndex, { name: "shop" }),
])
```

## Wrapping Middleware (Scoped to Children)

Use the wrapping form to scope middleware to a subset of routes without
introducing a visible layout:

```typescript
urls(({ path, middleware }) => [
  // authMw only applies to /admin and /admin/settings
  middleware(authMw, () => [
    path("/admin", AdminPage, { name: "admin" }),
    path("/admin/settings", SettingsPage, { name: "settings" }),
  ]),

  // Public route — no authMw
  path("/", HomePage, { name: "home" }),
]);
```

Multiple middleware with wrapping:

```typescript
middleware([authMw, loggingMw], () => [
  path("/admin", AdminPage, { name: "admin" }),
]);
```

This creates a transparent layout (`<Outlet />`) that carries the middleware.
The middleware does not affect sibling routes outside the callback.

## Middleware Context

```typescript
export const myMiddleware: Middleware = async (ctx, next) => {
  // Access request
  ctx.request; // Request object
  ctx.url; // Parsed URL
  ctx.params; // Route parameters
  ctx.build; // in middleware: true only during Prerender + ppr build-shell capture (plain Prerender does not run middleware)

  // Access platform bindings (plain bindings from createRouter<TEnv>())
  ctx.env.DB; // D1Database
  ctx.env.KV; // KVNamespace

  // Set variables for downstream handlers (typed via Rango.Vars)
  ctx.set("user", { id: "123", name: "John" });

  // Opt the current request out of PPR shell lookup/capture.
  ctx.dynamic();

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
via Rango.Vars augmentation). Use `createVar` for route-local or feature-scoped
data; use Rango.Vars for app-wide middleware state.

## Build-Time PPR Middleware

Normal `Prerender` Flight payload collection does not run middleware: there is
no request to wrap. The exception is `Prerender` + `ppr` build-shell capture.
After the Flight payload exists, the shell producer replays global and route
middleware for each generated URL before it captures HTML.

In that build-shell pass:

- `ctx.build === true`;
- `ctx.waitUntil()` is inert;
- `ctx.dynamic()` skips the baked shell for that URL;
- context variables set by middleware are visible to the shell render.

Use this to keep side effects predictable:

```typescript
export const commerceMiddleware: Middleware = async (ctx, next) => {
  if (ctx.build) {
    ctx.dynamic(); // leave this shell to runtime PPR
    return next();
  }

  const session = await commerce.auth(ctx.request);
  ctx.set("session", session);
  return next();
};
```

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
