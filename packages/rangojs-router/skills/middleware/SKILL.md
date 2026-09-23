---
name: middleware
description: Define global (router.use) and route (middleware()) middleware in @rangojs/router — auth gates, logging, response headers, context variables, redirects. Use when gating routes behind auth checks, logging requests, setting headers or ctx variables before a handler runs, or deciding whether middleware wraps server actions.
argument-hint: [middleware-name]
---

# Middleware

Middleware runs before and after route handlers using the onion model: code
before `await next()` runs on the way in, code after it runs on the way out
with the downstream `Response` available. This skill covers the two
registration levels (global `router.use()` and route `middleware()`), what each
wraps (actions, renders, fetchable loaders), the middleware context, and
common patterns.

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

Scope patterns use the route pattern syntax: `:param` (typed on `ctx.params`), optional `:param?`, constrained `:locale(en|gb)`, and a trailing `*` wildcard. When the router has a `basename`, pattern-scoped `.use()` patterns are automatically prefixed. For example, with `basename: "/app"`, `.use("/admin/*", mw)` matches `/app/admin/*`.

A pattern matches the request URL. Server actions are posted to the current page's URL, but an action can be invoked through any URL that matches a route, so a pattern-scoped guard is not an authorization boundary for actions. Authorize sensitive actions inside the action body (see `/server-actions` → "Authorization in actions").

### Route middleware (`middleware()` in `urls()`)

Registered inside `urls()` callback. Wraps **rendering only** -- it does NOT wrap server action execution. Actions run before route middleware, so when route middleware executes during post-action revalidation, it can observe state that the action set (cookies, context variables, headers).

> **Implication for auth:** route middleware cannot guard server actions. Load identity in global `router.use()` middleware (it wraps actions) and check authorization inside the action body. See `/server-actions` for action-side auth patterns.

```
Request flow (with action):
  global mw -> action executes -> route mw -> render pass

Request flow (no action):
  global mw -> route mw -> render pass

Fetchable loader request (_rsc_loader: useFetchLoader / load / useRefreshLoaders):
  global mw -> per-loader { middleware } list -> loader   (route mw does NOT run)

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
import type { Revalidate } from "@rangojs/router";
import * as CartActions from "./actions/cart";

export const revalidateCartData: Revalidate = (ctx) =>
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

Route middleware is the right place for per-route concerns that affect rendering (setting context variables for handlers, adding response headers, reading cookies set by actions). It is NOT the right place for action guards -- use global middleware to load identity and check authorization in the action body.

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

Every middleware must either call `next()` or return (or throw) a `Response`.
Returning or throwing a `Response` short-circuits the chain; downstream
middleware and the handler do not run, and headers/cookies already set on the
context are merged into it. A middleware that does neither throws an error; any
other return value is ignored with a warning. `await next()` resolves to the
downstream `Response`, so `return next()` and `await next()` are both fine.

## Using Middleware in Routes

```typescript
import { urls } from "@rangojs/router";
import { authMiddleware, loggerMiddleware } from "./middleware";

export const urlpatterns = urls(({ path, layout, middleware }) => [
  // Route middleware for every route in this urls() tree (wraps renders, not actions)
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
import { cookies, headers } from "@rangojs/router";
import type { Middleware } from "@rangojs/router";
import { FlashMessage } from "./location-states";

export const myMiddleware: Middleware = async (ctx, next) => {
  // Request
  ctx.request; // incoming Request (raw URL, method, body)
  ctx.url; // URL with internal _rsc* params stripped (also ctx.pathname, ctx.searchParams)
  ctx.params; // params from the router.use() pattern or the matched route
  ctx.routeName; // matched route name (reliable after await next() in global middleware)
  ctx.build; // true only during Prerender + ppr build-shell capture (plain Prerender does not run middleware)
  headers().get("accept-language"); // read-only request headers (free function)
  cookies().get("session")?.value; // request cookies (free function; also .set/.delete)

  // Platform bindings (plain bindings from createRouter<TEnv>())
  ctx.env.DB; // D1Database
  ctx.waitUntil(async () => {}); // work after the response is sent

  // Variables for downstream middleware, handlers, and loaders (typed via Rango.Vars)
  ctx.set("user", { id: "123", name: "John" });
  ctx.get("user");

  // Response shaping
  ctx.header("X-Frame-Options", "DENY"); // set one response header
  ctx.headers; // response Headers (stub before next(), the real response after)
  ctx.setLocationState(FlashMessage({ text: "Saved" })); // history state for the client
  ctx.reverse("home"); // URL for a global route name (no ".name", no param auto-fill)

  // Opt the current request out of PPR shell lookup/capture.
  ctx.dynamic();
  // Print the per-request performance timeline (see /loader → "debugPerformance").
  ctx.debugPerformance();

  // Continue to the next middleware / the handler
  const response = await next();

  // After the handler: the real Response is available
  console.log(response.status);
};
```

Cookies and request headers are not `ctx` members; use the free functions
`cookies()` and `headers()` from `@rangojs/router`.

### Changing the response after `next()`

After `await next()`, `ctx.header()` and `ctx.headers` write to the real
downstream response. Returning a different `Response` replaces it.

```typescript
export const securityHeaders: Middleware = async (ctx, next) => {
  await next();
  ctx.header("Strict-Transport-Security", "max-age=63072000");
  ctx.headers.set("X-Content-Type-Options", "nosniff");
};

export const timing: Middleware = async (ctx, next) => {
  const start = performance.now();
  try {
    await next();
  } finally {
    // try/catch around next() also sees downstream errors
    console.log(`${ctx.pathname} ${(performance.now() - start).toFixed(1)}ms`);
  }
};
```

### Typed context variables in middleware

Use `createVar<T>()` for type-safe data sharing between middleware and handlers:

```typescript
import { createVar } from "@rangojs/router";
import type { Middleware } from "@rangojs/router";

interface AuthUser { id: string; email: string; role: string }
// cache: false — per-user data must never bake into a cache() segment
export const CurrentUser = createVar<AuthUser>({ cache: false });

export const authMiddleware: Middleware = async (ctx, next) => {
  const token = ctx.request.headers.get("Authorization");
  if (!token) throw new Response("Unauthorized", { status: 401 });

  const user = await verifyToken(token);
  ctx.set(CurrentUser, user);  // type-checked
  await next();
};

// In a handler -- typed read
import type { Handler } from "@rangojs/router";
import { CurrentUser } from "./middleware";

const Dashboard: Handler<"dashboard"> = (ctx) => {
  const user = ctx.get(CurrentUser);  // typed as AuthUser | undefined
  return <DashboardPage user={user!} />;
};
```

This works alongside `ctx.get("key")` / `ctx.set("key", value)` (global typing
via Rango.Vars augmentation). Use `createVar` for route-local or feature-scoped
data; use Rango.Vars for app-wide middleware state.

Mark request-specific data (sessions, users, tokens) non-cacheable: either on
the token (`createVar<T>({ cache: false })`) or per write
(`ctx.set("user", user, { cache: false })`). Reading it with `ctx.get()` inside
a `cache()` boundary then throws instead of baking one user's data into a
shared entry; loaders can still read it because they always run fresh.

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
// location-states.ts — shared module; the client component that reads the
// state must import the same definition
import { createLocationState } from "@rangojs/router";

export const FlashMessage = createLocationState<{ text: string }>({
  flash: true,
});
```

```typescript
// middleware/auth.ts
import { redirect } from "@rangojs/router";
import type { Middleware } from "@rangojs/router";
import { FlashMessage } from "../location-states";

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
  // Route middleware for every route in this tree (use router.use() to also wrap actions)
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
