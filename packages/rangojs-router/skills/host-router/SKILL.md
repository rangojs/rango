---
name: host-router
description: Multi-app host routing with domain/subdomain patterns. Use when running multiple apps behind one domain or across subdomains, or routing requests to different apps based on hostname.
argument-hint:
---

# Host Router

Route requests to different apps based on domain, subdomain, or path prefix patterns. Supports middleware, lazy loading, cookie-based host override for dev, and a fallback handler.

Use it when one deployment serves several independently built Rango apps (or
plain request handlers) and the hostname or a path prefix decides which one
handles the request. Each sub-app is an ordinary `createRouter()` app; the host
router only picks which one runs. For a single app mounted under a sub-path,
use `basename` instead (`/router-setup`).

## Import

```typescript
import { createHostRouter, defineHosts } from "@rangojs/router/host";
```

## Basic Setup

```typescript
// host-router.ts
import { createHostRouter } from "@rangojs/router/host";

const router = createHostRouter();

router.host(["."]).lazy(() => import("./apps/main"));
router.host(["admin.*"]).lazy(() => import("./apps/admin"));
router.host(["api.*"]).lazy(() => import("./apps/api"));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.match(request, { env, ctx });
  },
};
```

## Deploying: Cloudflare vs node/vercel

How a host router is _served_ depends on the preset, because the preset decides who owns the server entry.

| Preset            | Who owns the entry          | What the host module exports                                                                                |
| ----------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `cloudflare`      | You (your `worker.rsc.tsx`) | `export default { fetch(request, env, ctx) { return router.match(request, { env, ctx }); } }`               |
| `node` / `vercel` | rango (generated RSC entry) | `export default router;` (the `HostRouter` instance itself), or a named `export const hostRouter`/`router`. |

On `node`/`vercel`, rango generates the served RSC entry, so it needs the `HostRouter` **instance** to call `hostRouter.match()` for you. Export the instance, not a `{ fetch }` object:

```typescript
// src/worker.rsc.tsx  (node / vercel)
import { createHostRouter } from "@rangojs/router/host";

export const hostRouter = createHostRouter();
hostRouter.host(["admin.*"]).lazy(() => import("./apps/admin/handler.js"));
hostRouter.host(["."]).lazy(() => import("./apps/site/handler.js"));

// Export the instance — the generated entry serves it via hostRouter.match().
export default hostRouter;
```

Each sub-app exports a handler exactly as on Cloudflare (no change):

```typescript
// src/apps/admin/handler.ts
import { router } from "./router.js";
export default (request: Request, input: any) => router.fetch(request, input);
```

Each sub-app has its own generated route map and `Rango.Env`; typecheck each
in its own TypeScript program (or give route names per-app prefixes) so the
global augmentations don't collide — see `/typesafety` (multi-project setup).

Selecting the host entry — a host app has several `createRouter()` sub-apps, so single-router auto-discovery can't pick one. Either let rango auto-detect the lone `createHostRouter()` file, or point at it explicitly:

```typescript
// vite.config.ts
rango({ preset: "vercel", hostRouter: "./src/worker.rsc.tsx" });
```

On Vercel this is a single function running `hostRouter.match()` for every request (mirrors the Cloudflare single-worker model); `{ env, ctx }` (`process.env` + `{ waitUntil }`) is threaded unchanged to each matched sub-app's handler and `cache(env, ctx)` factory. See `/vercel`.

Unmatched hosts on node/vercel: because rango owns the generated entry (you have no worker `try/catch`), it catches `NoRouteMatchError` and returns **404** by default — so you do **not** need a catch-all host route. If you want different behavior (a branded 404, a redirect, a default app), register a catch-all mount as the **last** route, e.g. `host(["**"]).lazy(() => import("./apps/site/handler.js"))` — it matches any host, so the built-in 404 only fires when nothing matched at all. (Note `fallback()` is for cookie-override errors, not general unmatched hosts.)

## Inline handlers (`.map`) vs lazy mounts (`.lazy`)

A host pattern maps to one of two things, and you pick the method by intent:

| Method  | Argument                       | Use for                                                      |
| ------- | ------------------------------ | ------------------------------------------------------------ |
| `.map`  | `(request, input) => Response` | An inline request handler that produces a response directly. |
| `.lazy` | `() => import("./sub-app")`    | A lazily-imported handler or nested host router (a sub-app). |

```typescript
// Lazy mount: the module's default export is a handler or a HostRouter.
router.host(["admin.*"]).lazy(() => import("./apps/admin"));

// Inline handler: returns a Response itself (sync or async).
router.host(["health.*"]).map(() => new Response("ok"));
router
  .host(["echo.*"])
  .map((request) => new Response(new URL(request.url).pathname));
```

Why two methods instead of one overloaded `.map()`:

- **Build-time discovery** invokes only `.lazy()` mounts (to trigger each sub-app's `createRouter()` registration). Inline `.map()` handlers are never invoked during discovery, so they can't crash it or pollute its errors.
- `.map(() => import("./sub-app"))` is a **type error** — a lazy import resolves to a module, not a `Response`. Use `.lazy()` for imports. (If the types are bypassed, e.g. from JS, a `.map()` handler that resolves to a module throws a clear `HostRouterError` at request time instead of returning the module.)
- A lazy loader may declare an ignored parameter (`.lazy((_request?) => import("./x"))`); `.lazy()` accepts it because intent is explicit, not inferred from the signature.

## Pattern Syntax

| Pattern           | Matches                                        |
| ----------------- | ---------------------------------------------- |
| `.` or `*`        | Any apex domain (`example.com`)                |
| `**`              | Any domain (apex + all subdomains)             |
| `*.`              | Any single-level subdomain (`www.example.com`) |
| `**.`             | Any multi-level subdomain (`a.b.example.com`)  |
| `example.com`     | Exact domain                                   |
| `*.com`           | Any apex `.com` domain                         |
| `*.example.com`   | Single subdomain of `example.com`              |
| `**.example.com`  | Any depth subdomain of `example.com`           |
| `admin.*`         | `admin` subdomain of any apex domain           |
| `admin.**`        | `admin` subdomain of any domain                |
| `admin.`          | `admin` subdomain of any apex (no wildcard)    |
| `example.com/api` | Domain + path prefix (prefix match)            |

Patterns are tested in registration order. First match wins.

Matching details:

- **Apex means exactly two labels.** There is no Public Suffix List:
  `example.co.uk` has three labels, so `.`/`*` do not match it and `*.` does.
  `localhost` has one label, so it matches neither `.` nor `*.`; use an exact
  `localhost` pattern (or `**`) for local dev.
- **Hosts are case-insensitive; paths are not.** A path prefix matches the
  exact path or anything below it (`example.com/api` matches `"/api"` and
  `"/api/x"`, not `"/apix"`). A trailing `/` on the pattern is ignored.
- A pattern that is empty, not a string, or contains whitespace throws
  `InvalidPatternError` at registration.

## `defineHosts` for Type Safety

```typescript
import { defineHosts } from "@rangojs/router/host";

const hosts = defineHosts({
  admin: "admin.*",
  api: "api.*",
  app: [".", "www.*"],
});

router.host(hosts.admin).lazy(() => import("./apps/admin"));
router.host(hosts.app).lazy(() => import("./apps/main"));
```

Returns a frozen object — keys are autocompleted by TypeScript.

## Middleware

Global middleware runs for every matched route. Per-route middleware runs only for that host pattern.

```typescript
import { createHostRouter, type Middleware } from "@rangojs/router/host";

const router = createHostRouter();

// Global — runs for all routes
router.use(async (request, input, next) => {
  console.log(`[${new Date().toISOString()}] ${request.url}`);
  return next();
});

// Per-route: return a Response without calling next() to short-circuit
const requireAuth: Middleware = async (request, input, next) => {
  if (!request.headers.get("authorization")) {
    return new Response("Unauthorized", { status: 401 });
  }
  return next();
};

router
  .host(["admin.*"])
  .use(requireAuth)
  .lazy(() => import("./apps/admin"));
```

Middleware signature: `(request: Request, input: RouterRequestInput, next: () => Promise<Response>) => Promise<Response>`

Global middleware runs first, then the matched route's middleware, then the
handler. `input` is typed `RouterRequestInput<any>` on purpose: one host router
fans out to sub-apps with different env shapes, so `input.env`/`input.vars` are
`any` here and each sub-app types its own env via `createRouter<TEnv>()`.

Calling `next()` more than once throws.

## Fallback Handler

Handles cookie-override errors when `hostOverride` is configured (e.g., override from a disallowed host, invalid cookie hostname, a throwing `validate`). The fallback does **not** catch unmatched hosts — those throw `NoRouteMatchError`. Catch that at the worker level if you need a 404.

```typescript
const router = createHostRouter({
  hostOverride: { cookieName: "x-dev-host", allowedHosts: ["localhost"] },
});

// Called when cookie override fails (not for general unmatched hosts).
// Global middleware and the fallback's own middleware still run.
router.fallback().map((request, input) => {
  // The override error is passed on the input (not part of RouterRequestInput's type)
  const { error } = input as { error?: Error };
  return new Response(`Invalid host override: ${error?.message}`, {
    status: 400,
  });
});
```

Without a registered fallback, a failed override returns a `400` JSON
response (`{ error, message }`) that also clears the override cookie
(`Set-Cookie: <cookieName>=; Max-Age=0`).

For unmatched hosts without `hostOverride`, catch `NoRouteMatchError` in your worker fetch. Use the `isNoRouteMatchError()` guard rather than a bare `instanceof`: a workspace with a duplicated `@rangojs/router` copy can throw the error with a different class identity, and `instanceof` would then turn the 404 into an opaque 500.

```typescript
import { isNoRouteMatchError } from "@rangojs/router/host";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return await router.match(request, { env, ctx });
    } catch (err) {
      if (isNoRouteMatchError(err)) {
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
2. If cookie present and the actual host matches an `allowedHosts` pattern → use the cookie value as the hostname (after `validate`, when given)
3. If cookie present but the host is not allowed → `HostOverrideNotAllowedError`, handled by the fallback (see above)

Without a custom `validate`, the cookie value must parse as a bare hostname via
`new URL()` (no port or path) and is lowercased; otherwise
`InvalidHostnameError`. A custom `validate` returns the effective hostname; if
it throws, the error is wrapped in `HostValidationError`. The effective
hostname is then matched against the host patterns as usual.

## Debug Mode

```typescript
const router = createHostRouter({ debug: true });
```

Logs pattern matching, route registration, and cookie override decisions to console.

## Testing

```typescript
import {
  createTestRequest,
  testPattern,
  matchesHost,
} from "@rangojs/router/host/testing";

// Test pattern matching (host-only)
testPattern("admin.*", "admin.example.com"); // true
testPattern([".", "www.*"], "example.com"); // true

// Path-based patterns need the third pathname arg (defaults to "/", so a
// host-only pattern still works with two args):
testPattern("**.workers.dev/admin", "foo.workers.dev", "/admin"); // true

// Or match a pattern against a real Request (hostname + pathname from the URL):
matchesHost(
  "**.workers.dev/admin",
  new Request("https://foo.workers.dev/admin"),
); // true

// Create requests for integration tests (method defaults to GET, path to "/")
const request = createTestRequest({
  host: "admin.example.com",
  path: "/dashboard",
  method: "POST",
  headers: { authorization: "Bearer test" },
  cookies: { "x-dev-host": "api.example.com" },
});
const response = await router.match(request);

// Test which route would match (without executing)
router.test("admin.example.com"); // { pattern, handler, kind } | null
```

## Error Types

All errors extend `HostRouterError`:

| Error                         | When                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `InvalidPatternError`         | Pattern is empty, non-string, or has spaces                                                       |
| `HostOverrideNotAllowedError` | Cookie override from disallowed host                                                              |
| `InvalidHostnameError`        | Cookie value isn't a valid hostname                                                               |
| `HostValidationError`         | Custom `validate` function threw                                                                  |
| `NoRouteMatchError`           | No host pattern matched the request                                                               |
| `InvalidHandlerError`         | Handler is not a function, or a lazy mount resolved to a module without a usable `default` export |
| `HostRouterError`             | A `.map()` inline handler resolved to a module namespace (a misused lazy import — use `.lazy()`)  |

See the fallback section above for a `NoRouteMatchError` catch example.

## Nesting Host Routers

A lazy mount can resolve to another `HostRouter`:

```typescript
// apps/regional.ts
import { createHostRouter } from "@rangojs/router/host";

const regional = createHostRouter();
regional.host(["us.*"]).lazy(() => import("./regions/us"));
regional.host(["eu.*"]).lazy(() => import("./regions/eu"));

export default regional;
```

```typescript
// host-router.ts
router.host(["**.regional.example.com"]).lazy(() => import("./apps/regional"));
```

## Cross-app navigation is a full document load

A client-side navigation that crosses an app boundary (e.g. a `<Link>` or
intercepted `<a>` from the app at `/` into an app mounted at `/shop`) is a **hard
document navigation**, not a soft in-tree swap. When the server sees a partial
(SPA) request whose router id doesn't match the matched app, it returns
`X-RSC-Reload` and the client does a real document navigation to the target.

Why a reload rather than a soft swap: a soft swap can't faithfully re-establish
the target app's **document-level** state. Stylesheets shared across apps are
dropped by React 19's by-`href` resource dedup; and theme, warmup, and
prefetch-TTL are document-lifetime (captured once at document load), so the
target app's config would never take effect. A
full document load re-establishes the target app's entire document — CSS, theme,
meta, everything — by construction. So you do **not** need to coordinate
stylesheet `href`s, `precedence`, theme config, etc. across independently-authored
apps; each app owns its own document.

**Within-app** navigation is unchanged — a normal soft SPA update (the document
stays mounted). Only crossing an app boundary triggers the reload.
