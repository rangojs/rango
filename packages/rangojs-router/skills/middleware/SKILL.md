---
name: middleware
description: Define global (router.use) and route (middleware()) middleware in @rangojs/router — auth gates, logging, response headers, context variables, redirects, rewrites (throw rewrite() renders another route at the same URL). Use when gating routes behind auth checks, logging requests, setting headers or ctx variables before a handler runs, showing a maintenance page at the visitor's URL, or deciding whether middleware wraps server actions.
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

Registered on the router instance. Wraps the **entire request**, including server actions, rendering, and progressive enhancement (PE) re-renders. A request a middleware rewrites (`throw rewrite()`, below) runs the chain again for the target: once per pass.

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

The contract is: **route middleware wraps rendering regardless of transport** (JS-enabled RSC stream or no-JS HTML). During PE re-render, route middleware observes action-set state (cookies, context variables) the same way it does during JS-enabled post-action revalidation. When the action throws, the `errorBoundary()` render is wrapped too, in both transports: the boundary reads the middleware's `ctx.set()` values and the response carries its headers.

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
segments. On a PPR shell HIT no handler or layout runs; on a route `cache()`
HIT the segments inside the `cache()` boundary don't run, and those above it
do. Output that didn't run shows the values read when the shell was captured
or the entry written.

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

That scope comes from the routes inside the callback. With no routes inside,
the wrapper scopes nothing: its middleware runs for every route of the
enclosing path or layout. Such a wrapper cannot contain `layout()`;
`router.routes()` throws and points to the flat form:

```typescript
// throws at definition time
path("/account", AccountPage, { name: "account" }, () => [
  middleware(requireAuth, () => [layout(<AccountNav />)]),
]);
// same behavior, written flat
path("/account", AccountPage, { name: "account" }, () => [
  middleware(requireAuth),
  layout(<AccountNav />),
]);
```

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
  ctx.reverse("home"); // URL for a global route name (no ".name", no param auto-fill; a missing required param throws)
  ctx.rewrittenFrom; // the visitor's URL when this request was rewritten, else undefined
  ctx.isRewrite(error); // true for a thrown rewrite() (rethrow it from a try/catch)

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

Middleware reads request identity freely: `cookies()`, `headers()` and
`ctx.request.headers` alike. The same `Request` reaches handlers and loaders
as `ctx.request`, and there `ctx.request.headers` answers like `headers()`: it
throws inside a `cache()` boundary or a `"use cache"` function and refuses a
`ppr` shell capture (#976). To render a header on a cached or `ppr` route,
copy it here with `ctx.set()` (a cacheable variable) and include it in the
route's `cache()` `key()`, so each value gets its own record and shell:

```typescript
const Tier = createVar<string>();

export const tierMiddleware: Middleware = async (ctx, next) => {
  ctx.set(Tier, ctx.request.headers.get("x-tier") ?? "free");
  return next();
};
// cache({ key: (ctx) => `tier:${ctx.request.headers.get("x-tier") ?? "free"}` }, ...)
```

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
a `cache()` boundary or a `"use cache"` function then throws instead of baking
one user's data into a shared entry (inside `"use cache"`, also through a
middleware `ctx` passed in); under `cache()` loaders can still read it because a
DSL loader re-runs on every hit (a `"use cache"` function a loader calls cannot,
and a loader bound with its own `cache()` only with a `key()`, which switches
the check off, so the key must include the value). On a `ppr` route only a
loader without `ssr: false` that no handler awaits may read it: a read the shell
capture waits for refuses the capture. A middleware `ctx` passed to a
`"use cache"` function keys the call by host, pathname, params and search, plus
the route name once the route is matched (a global middleware before `next()`
has none yet), and its `set()`, `header()` and `headers` writes throw inside the
function (`/use-cache`).

## Build-Time PPR Middleware

Normal `Prerender` Flight payload collection does not run middleware: there is
no request to wrap. The exception is `Prerender` + `ppr` build-shell capture.
After the Flight payload exists, the build replays global and route middleware
for each generated URL before capturing the shell.

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

A redirect is followed on a link click, `router.push()`, and Back/Forward to an entry the client has to fetch. On Back/Forward the redirect replaces the history entry it was triggered from: Back from the target lands on the entry before the redirecting one, not on the redirecting one again. The client follows at most 20 redirects in one navigation; a loop (two pages redirecting to each other) stops there with the error boundary and a `[rango] Server redirect loop` console error.

## Rewrite: another route at the same URL

`throw rewrite(target)` renders another route while the address bar keeps the
visitor's URL: a maintenance or lock page, a deploy migration, a URL override,
an A/B or geo split. A redirect changes the URL; a rewrite does not.

```typescript
import { getRequestContext, rewrite } from "@rangojs/router";
import type { Middleware } from "@rangojs/router";

export const maintenance: Middleware = async (ctx, next) => {
  if (!locked || ctx.pathname === "/maintenance") return next();
  // Global middleware runs before the action: a lock answers mutations with a
  // Response, so the action never runs under maintenance.
  if (ctx.request.method !== "GET") {
    return new Response("Maintenance", {
      status: 503,
      headers: { "Retry-After": "600" },
    });
  }
  ctx.set(Lock, { until });
  throw rewrite("maintenance");
};

// urls.tsx — the target sets its own status
path("/maintenance", MaintenancePage, { name: "maintenance" }, () => [
  middleware(async (ctx, next) => {
    getRequestContext().setStatus(503);
    ctx.header("Retry-After", "600");
    await next();
  }),
]);
```

Targets, like `ctx.reverse` with a path form:

```typescript
throw rewrite("/maintenance"); // a path (basename-prefixed like redirect())
throw rewrite("/maintenance?from=shop"); // a path with search
throw rewrite("maintenance"); // a global route name without params
throw rewrite("product", { slug }); // with params
throw rewrite("product", { slug }, { tab: "reviews" }); // and search
```

**How it runs.** The throw unwinds the request to the router, which runs it
again as the target, from the top, as a direct visit would: global middleware
matched on the target's path (a `.use("/admin/*", guard)` or an inline
`ctx.pathname` check decides on the rendered route), the target's route
middleware, its render. Code after `await next()` in the pass that rewrote
never runs, and global middleware runs once per pass.

**Never skip a guard on a rewritten pass.** Authorization, auth and
rate-limit checks run on every pass, as written: the target's guards
deciding on the rendered route is what keeps a rewrite from becoming a way
around them. `if (!ctx.rewrittenFrom)` is only for side effects you want
once per request, such as a counter or a log line:

```typescript
export const countVisit: Middleware = async (ctx, next) => {
  if (!ctx.rewrittenFrom) visits.increment(); // once per request
  return next();
};
```

**Throw it before `await next()`.** Once your `next()` ran the route, the
page has rendered: a `throw rewrite()` after it (a "rewrite on 404" after
`const res = await next()`) is an error, "throw rewrite() before await
next()". Decide before calling `next()`. A rewrite thrown further down
passes through your `await next()` as usual, and in a `catch` around it you
may throw another rewrite in its place; after any other failure of `next()`
(the route may have rendered before it failed) a rewrite is an error too.

**Same request context.** Values you `ctx.set()` before the throw are
readable in the target's middleware, handlers and loaders; cookies, headers
and the status you set stay on the response; location state, theme and
`ctx.dynamic()` carry over. The request, URLs, params and route name are the
target's.

**Old and new URL.** `ctx.url`, `ctx.pathname` and `ctx.searchParams` are
the target's; `ctx.rewrittenFrom` is the visitor's URL (search included; the
first URL after several rewrites; `undefined` when nothing rewrote).
`usePathname()` and `useSearchParams()` show the visitor's URL in the server
HTML and after hydration, except in a render other visitors are served (see
Caches); `useParams()` and the route name are the target's. The response
carries `x-rango-rewrite: <target pathname>`.

**`ctx.rewrittenFrom` is request identity**, like `cookies()`: reading it
inside a `cache()` boundary or a `"use cache"` function throws (pass what
you need in from middleware), and a render other visitors may be served (a
PPR shell capture, a page the document cache stores) reads `undefined`, as a
direct visit does. A shell keyed by the visitor's URL
(`rewrite(...).shell("visitor")`, see Caches) reads it, since its key covers
that URL.

**Middleware only, by design.** `rewrite()` is a middleware tool. A route
handler or a loader (any loader, `ssr: false` included) cannot rewrite: its
throw is an error whose message points you to route middleware. A rewrite
that depends on data goes in the route's middleware, reading the data
through a cached function the loader shares, so the lookup runs once:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  middleware(async (ctx, next) => {
    const product = await getProduct(ctx.params.slug); // cached, shared with the loader
    if (product.discontinued) {
      throw rewrite("discontinued", { slug: ctx.params.slug });
    }
    await next();
  }),
  loader(productLoader), // calls getProduct(slug): a cache hit
]);
```

**Mutations: where the middleware sits decides.** A server action or a no-JS
form post from a rewritten page is posted to the visitor's URL, so the same
middleware sees it:

- **Global middleware** on the visitor's URL runs before the action. A
  rewrite there is refused for a non-GET request, before the action runs:
  return a `Response` for mutations, as the lock above does.
- **Route middleware** runs after the action, around the re-render. A
  routing rewrite there (A/B, URL override, the `discontinued` example
  above) rewrites every method, as written: the action runs once, then the
  re-render runs as the target (its global and route middleware, its
  render, or its error boundary when the action threw), and the page keeps
  its layout and state. Don't skip mutations
  with `if (ctx.request.method !== "GET") return next()` in route
  middleware: the re-render would then show the rewriting route instead of
  the page on screen. A `Response` returned from route middleware for a
  mutation also comes after the action ran: it is not a lock.
- The target's pass is still the POST, with its headers. A no-JS form post
  keeps its body, so a form-field check (a CSRF token read from
  `ctx.request.clone().formData()`) passes on every pass. A JS action's
  body is gone (the action read it): middleware that reads it on the
  target's pass gets an empty body, so read it only when
  `ctx.rewrittenFrom` is unset. Global middleware runs once per pass, as
  for any rewrite. The target must be a page route: a rewrite of a
  mutation to a response route (`path.json()`) is an error.

**Throw it, don't return it.** A returned rewrite is an error. Where a
rewrite cannot be honored it is an error that names the rule: a route
handler or a loader (see above), a server action (use `redirect()`),
intercept middleware, a loader fetch (`useFetchLoader`, `load()`: it
rejects with the rule) or its middleware, and global middleware handling a
non-GET request (a JS action or a no-JS form post: return a `Response`).

**try/catch around next().** A thrown rewrite passes through your
middleware's `catch`. Rethrow it:

```typescript
export const errorPage: Middleware = async (ctx, next) => {
  try {
    return await next();
  } catch (error) {
    if (ctx.isRewrite(error)) throw error;
    return new Response("Something went wrong", { status: 500 });
  }
};
```

**Loops.** More than 5 rewrites in one request, or a rewrite to the URL the
request is on, answers 508 and reports a `RewriteLoopError` (its message has
the trail, `/a -> /b -> /a`) through `onError` with phase `"routing"`.

**Caches.**

- The document cache keys a rewritten request by the target's URL, as a
  direct visit. Register the rewriting middleware **before**
  `createDocumentCacheMiddleware()`: a cache hit for the visitor's URL would
  be served before your middleware runs. A page the document cache stores
  is rendered as a direct visit to the target: it carries the target's
  pathname and `ctx.rewrittenFrom` is `undefined` there, so a component that
  renders `usePathname()` can mismatch on hydration at the visitor's URL
  when such a page is served to a rewritten request.
- A PPR shell (`ppr` target) is read and written only by requests on its
  URL. A rewritten request renders live at the visitor's URL, and a direct
  visit captures the target's shell, so values you set before the throw
  never reach it. Pick a shell for the rewritten request with `.shell()` on
  the thrown value: `"visitor"` keys a shell by the visitor's URL, captured
  with the visitor's location and `ctx.rewrittenFrom` (one shell per public
  URL, the right choice for a routing catch-all); `"target"` reads and
  captures the target's shared shell, which shows the target's URL to the
  visitor on a HIT and bakes in what the rewriting middleware set, so keep it
  for a lock or promo page that renders neither:

  ```typescript
  throw rewrite("item", { id }).shell("visitor");
  ```

- The client's prefetch and history caches keep a rewritten page under the
  visitor's URL, and nothing tells them about the rewrite: a page prefetched
  during a lock shows the lock page for up to `prefetchCacheTTL` after the
  lock lifts. `invalidateClientCache()` drops a client's caches, for the
  client that receives the response; mark the clients that saw the lock and
  call it on their first response after it lifts:

  ```typescript
  import { cookies, invalidateClientCache, rewrite } from "@rangojs/router";

  export const maintenance: Middleware = async (ctx, next) => {
    if (!locked) {
      if (cookies().get("saw-lock")) {
        cookies().delete("saw-lock");
        invalidateClientCache();
      }
      return next();
    }
    cookies().set("saw-lock", "1", { path: "/" });
    // ...the lock as above
    throw rewrite("maintenance");
  };
  ```

**Navigating from a rewritten page.** A navigation, prefetch or action from
the page diffs against the route that rendered it, as one from a direct
visit does: the payload carries the target (`metadata.rewriteTarget`), and
the browser sends it back with the next request from that page. A
`revalidate()` sees the target's params and URL (`currentParams.id` against
`nextParams.id` holds a loader on a sort change), and a navigation to the
page already shown re-renders nothing. A move to another visitor URL with
the same target (`/promo/a` to `/promo/b`, both rewritten to `/promo/landing`) re-runs the
route and its loaders, which may read `ctx.rewrittenFrom`. The header only
names the page being left: what renders still comes from the request's URL
and your middleware.

**Testing.** `runMiddleware` reports a thrown rewrite as `result.rewrite`
(`{ pathname, search, routeName? }`). `serveShellRequest` takes a rewritten
page request through the full production pipeline (document or `partial`
navigation): the target's middleware, render, status and `x-rango-rewrite`.
Pass the page's `metadata.rewriteTarget` as `partial.rewriteTarget` (or
`action.rewriteTarget`) to send a request from it as the browser does.
With `action` or `form` (from `createActionForm`) it posts a mutation to the
visitor's URL, so a route-middleware rewrite's re-render is testable too.
`dispatch` re-dispatches too, for response routes only: it matches the
visitor's URL first and throws on a component (RSC) route.
`renderRoute(..., { request: "/shop", rewrite: "/maintenance" })` renders
the target's route at the visitor's URL. See `/testing`.

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
