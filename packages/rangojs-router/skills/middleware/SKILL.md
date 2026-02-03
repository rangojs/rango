---
name: middleware
description: Define middleware for authentication, logging, and request processing in @rangojs/router
argument-hint: [middleware-name]
---

# Middleware

Middleware runs before/after route handlers using the onion model.

## Router-Level Middleware

Register middleware on the router with `.use()`:

```typescript
// router.tsx
import { createRSCRouter } from "@rangojs/router/server";

const router = createRSCRouter<AppEnv>({ document: Document })
  // Global middleware (runs for ALL routes)
  .use(loggerMiddleware)
  .use(requestIdMiddleware)

  // Pattern-based middleware (runs for matching paths)
  .use("/admin/*", adminAuthMiddleware)
  .use("/api/*", rateLimitMiddleware)
  .use("/api/:version/*", apiVersionMiddleware)

  // Routes with scoped middleware
  .routes("/shop", shopRoutes)
  .use(shopAuthMiddleware)  // Only runs for /shop/* routes
  .map(() => import("./handlers/shop"));
```

**Pattern matching:**
- `*` - Match all routes
- `/admin/*` - Match `/admin` and anything under it
- `/users/:id` - Match `/users/123`, extract `{ id: "123" }`
- `/api/:version/*` - Match `/api/v1/users`, extract `{ version: "v1" }`

## Middleware Scoping Rules

**Key insight:** `.map()` returns the **router** (not the builder), so after `.map()` you're back to global scope.

```typescript
const router = createRSCRouter<AppEnv>({ document: Document })
  // GLOBAL - no mount prefix
  .use(loggerMiddleware)           // Runs for ALL routes

  // SCOPED to /shop/*
  .routes("/shop", shopRoutes)
  .use(shopAuthMiddleware)         // Only /shop/*
  .use("/cart/*", cartMiddleware)  // Only /shop/cart/*
  .map(() => import("./handlers/shop"))

  // GLOBAL again - .map() returned router, not builder
  .use(anotherMiddleware)          // Runs for ALL routes (including /admin)

  // SCOPED to /admin/*
  .routes("/admin", adminRoutes)
  .use(adminAuthMiddleware)        // Only /admin/*
  .map(() => import("./handlers/admin"))

  // GLOBAL again
  .use(finalMiddleware);           // Runs for ALL routes
```

**The chain structure:**
```
router.use()     → returns router (global middleware)
router.routes()  → returns builder (scoped to mount prefix)
builder.use()    → returns builder (middleware scoped to mount prefix)
builder.map()    → returns router (ends scope, back to global)
```

**Example execution order:**
```typescript
.use(A)                    // Global: all routes
.routes("/shop", shop)
  .use(B)                  // Scoped: /shop/*
  .use("/vip/*", C)        // Scoped: /shop/vip/*
  .map(...)
.use(D)                    // Global: all routes
.routes("/admin", admin)
  .use(E)                  // Scoped: /admin/*
  .map(...)
.use(F)                    // Global: all routes
```

Result:
- `/shop/products` → A, B, D, F
- `/shop/vip/lounge` → A, B, C, D, F
- `/admin/dashboard` → A, D, E, F
- `/` (home) → A, D, F

## Handler-Level Middleware

Register middleware within route handlers using the `middleware()` helper:

```typescript
import { map } from "@rangojs/router/server";

export default map<typeof routes>(({ route, middleware }) => [
  // Handler-wide middleware
  middleware(async (ctx, next) => {
    console.log("Request started:", ctx.pathname);
    const start = Date.now();

    await next();

    const duration = Date.now() - start;
    ctx.header("X-Response-Time", `${duration}ms`);
  }),

  route("index", IndexHandler),
]);
```

## Route-Specific Middleware

Apply middleware to individual routes:

```typescript
export default map<typeof routes>(({ route, middleware }) => [
  // No middleware
  route("public", PublicPage),

  // With route-specific middleware
  route(
    "dashboard",
    (ctx) => <DashboardPage user={ctx.get("user")} />,
    () => [
      middleware(async (ctx, next) => {
        const user = await getUser(ctx.request);
        if (!user) throw redirect("/login");
        ctx.set("user", user);
        await next();
      }),
    ]
  ),
]);
```

## Middleware Context API

```typescript
middleware(async (ctx, next) => {
  // Request info
  ctx.request        // Raw Request object
  ctx.url            // URL object
  ctx.pathname       // Current path
  ctx.searchParams   // URLSearchParams
  ctx.params         // Route parameters (from pattern)
  ctx.env            // Platform bindings (Cloudflare, etc.)

  // Variable storage (share data with handlers)
  ctx.set("user", { id: "123", name: "John" });
  ctx.get("user");   // Retrieve stored value

  // Response headers
  ctx.header("X-Custom", "value");

  // Cookies
  ctx.cookie("session");           // Read request cookie
  ctx.cookies();                   // Read all cookies as object
  ctx.setCookie("auth", "token", { httpOnly: true, secure: true });
  ctx.deleteCookie("old-session");

  await next();

  // After handler - access response
  ctx.res;           // Response object (available after next())
});
```

## Authentication Middleware

```typescript
// middleware/auth.ts
import { redirect } from "@rangojs/router/server";

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

## Scoped Middleware in Layouts

Apply middleware to layout children:

```typescript
export default map<typeof routes>(({ route, layout, middleware }) => [
  // Public routes (no auth)
  route("index", HomePage),
  route("about", AboutPage),

  // Protected routes - middleware applies to layout and all children
  layout(<DashboardLayout />, () => [
    middleware(authMiddleware),  // Runs for all dashboard routes

    route("dashboard.index", DashboardPage),
    route("dashboard.settings", SettingsPage),
  ]),
]);
```

## Loader Middleware

Middleware specific to a loader:

```typescript
import { createLoader } from "@rangojs/router/server";

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

Stop execution early by returning a Response or throwing:

```typescript
// Return Response to short-circuit
export const maintenanceMiddleware = async (ctx, next) => {
  if (isMaintenanceMode()) {
    return new Response("Under Maintenance", { status: 503 });
  }
  await next();
};

// Throw redirect
export const redirectMiddleware = async (ctx, next) => {
  if (ctx.pathname === "/old-path") {
    throw redirect("/new-path");
  }
  await next();
};

// Return early for auth
export const authGuard = async (ctx, next) => {
  if (!isAuthenticated(ctx)) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/login" },
    });
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

## Type-Safe Route Middleware

Use `RouteMiddlewareFn` for type-safe params:

```typescript
import type { RouteMiddlewareFn } from "@rangojs/router";
import type { shopRoutes } from "./routes/shop";

// Middleware with typed params from route definition
export const productMiddleware: RouteMiddlewareFn<
  typeof shopRoutes,
  "shop.product"  // Route has :slug param
> = async (ctx, next) => {
  // ctx.params.slug is typed as string
  console.log("Viewing product:", ctx.params.slug);
  await next();
};
```

## Middleware Type Signatures

```typescript
// Basic middleware function
type MiddlewareFn<TEnv = any, TParams = Record<string, string>> = (
  ctx: MiddlewareContext<TEnv, TParams>,
  next: () => Promise<Response>
) => Response | Promise<Response> | void | Promise<void>;

// Middleware context
interface MiddlewareContext<TEnv, TParams> {
  request: Request;
  url: URL;
  pathname: string;
  searchParams: URLSearchParams;
  env: TEnv;
  params: TParams;
  res: Response;

  cookie(name: string): string | undefined;
  cookies(): Record<string, string>;
  setCookie(name: string, value: string, options?: CookieOptions): void;
  deleteCookie(name: string, options?: CookieOptions): void;

  get<K extends string>(key: K): any;
  set<K extends string>(key: K, value: any): void;
  header(name: string, value: string): void;
}
```

## Cookie Options

```typescript
interface CookieOptions {
  domain?: string;
  path?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
}

// Example
ctx.setCookie("session", token, {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 7,  // 1 week
  path: "/",
});
```
