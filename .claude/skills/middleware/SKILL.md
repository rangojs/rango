---
name: middleware
description: Define middleware for authentication, logging, and request processing in rsc-router
argument-hint: [middleware-name]
---

# Middleware Routes

Middleware runs before/after route handlers using the onion model.

## Basic Middleware

```typescript
import { map } from "rsc-router/server";

export default map<typeof routes>(({ route, middleware }) => [
  middleware(async (ctx, next) => {
    // BEFORE handler
    console.log("Request started:", ctx.pathname);
    const start = Date.now();

    await next(); // Continue to handler

    // AFTER handler
    const duration = Date.now() - start;
    ctx.header("X-Response-Time", `${duration}ms`);
  }),

  route("index", IndexHandler),
]);
```

## Middleware Context API

```typescript
middleware(async (ctx, next) => {
  // Request info
  ctx.request     // Raw Request object
  ctx.url         // URL object
  ctx.pathname    // Current path
  ctx.method      // GET, POST, etc.
  ctx.params      // Route parameters

  // Variable storage (share data with handlers)
  ctx.set("user", { id: "123", name: "John" });
  ctx.get("user"); // Retrieve stored value
  ctx.var;         // All stored variables

  // Response headers
  ctx.header("X-Custom", "value");
  ctx.setCookie("session", "abc", { httpOnly: true });

  await next();

  // After handler - access response
  ctx.res;         // Response object (only after next())
});
```

## Authentication Middleware

```typescript
// middleware/auth.ts
import { redirect } from "rsc-router/server";

export const authMiddleware = async (ctx, next) => {
  const session = ctx.request.headers.get("Authorization");

  if (!session) {
    throw redirect("/login");
  }

  const user = await verifySession(session);
  if (!user) {
    throw redirect("/login");
  }

  ctx.set("user", user);
  await next();
};

// Usage in handler
export default map<typeof routes>(({ route, layout, middleware }) => [
  middleware(authMiddleware),

  layout(<DashboardLayout />, () => [
    route("dashboard.index", (ctx) => {
      const user = ctx.get("user"); // From middleware
      return <Dashboard user={user} />;
    }),
  ]),
]);
```

## Scoped Middleware

Apply middleware to specific routes:

```typescript
export default map<typeof routes>(({ route, layout, middleware }) => [
  // Public routes (no auth)
  route("index", HomePage),
  route("about", AboutPage),

  // Protected routes (with auth)
  middleware(authMiddleware),
  layout(<DashboardLayout />, () => [
    route("dashboard", DashboardPage),
    route("settings", SettingsPage),
  ]),
]);
```

## Multiple Middleware (Onion Model)

```typescript
export default map<typeof routes>(({ route, middleware }) => [
  middleware(loggerMiddleware),    // 1st: Enter first, exit last
  middleware(authMiddleware),      // 2nd: Enter second, exit second
  middleware(rateLimitMiddleware), // 3rd: Enter third, exit first

  route("api", ApiHandler),        // Handler runs in the middle
]);
```

Execution order:
```
loggerMiddleware (enter)
  authMiddleware (enter)
    rateLimitMiddleware (enter)
      ApiHandler executes
    rateLimitMiddleware (exit)
  authMiddleware (exit)
loggerMiddleware (exit)
```

## Global Middleware (Router Level)

```typescript
// router.tsx
const router = createRSCRouter<AppEnv>({
  document: RootLayout,
})
  .use(globalLoggerMiddleware)     // All routes
  .use("/api/*", apiAuthMiddleware) // Pattern-based
  .use("/admin/*", adminMiddleware)

  .routes("/", routes)
  .map(() => import("./handlers/main.js"));
```

## Loader Middleware

Middleware specific to a loader:

```typescript
import { createLoader } from "rsc-router/server";

export const UserProfileLoader = createLoader(
  async (ctx) => {
    const userId = ctx.get("userId"); // From loader middleware
    return db.users.findUnique({ where: { id: userId } });
  },
  {
    middleware: [
      async (ctx, next) => {
        const userId = ctx.params.id;
        ctx.set("userId", userId);
        await next();
      },
    ],
  }
);
```

## Short-Circuit Middleware

Stop execution early:

```typescript
export const maintenanceMiddleware = async (ctx, next) => {
  if (isMaintenanceMode()) {
    // Don't call next() - returns immediately
    return <MaintenancePage />;
  }
  await next();
};

export const redirectMiddleware = async (ctx, next) => {
  if (ctx.pathname === "/old-path") {
    throw redirect("/new-path");
  }
  await next();
};
```

## Error Handling Middleware

```typescript
export const errorMiddleware = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (error instanceof AuthError) {
      throw redirect("/login");
    }
    if (error instanceof NotFoundError) {
      throw notFound();
    }
    // Re-throw other errors
    throw error;
  }
};
```

## CORS Middleware Example

```typescript
export const corsMiddleware = async (ctx, next) => {
  ctx.header("Access-Control-Allow-Origin", "*");
  ctx.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  ctx.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (ctx.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  await next();
};
```

## Rate Limiting Middleware Example

```typescript
const rateLimiter = new Map<string, number[]>();

export const rateLimitMiddleware = async (ctx, next) => {
  const ip = ctx.request.headers.get("CF-Connecting-IP") ?? "unknown";
  const now = Date.now();
  const windowMs = 60000; // 1 minute
  const maxRequests = 100;

  const requests = rateLimiter.get(ip) ?? [];
  const recentRequests = requests.filter((t) => now - t < windowMs);

  if (recentRequests.length >= maxRequests) {
    ctx.header("Retry-After", "60");
    return new Response("Too Many Requests", { status: 429 });
  }

  recentRequests.push(now);
  rateLimiter.set(ip, recentRequests);

  await next();
};
```

## Middleware Type Signature

```typescript
type Middleware<Env = unknown> = (
  ctx: MiddlewareContext<Env>,
  next: () => Promise<void>
) => Promise<void | Response | JSX.Element>;
```
