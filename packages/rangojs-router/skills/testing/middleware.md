# Testing middleware — runMiddleware

**Layer:** unit (node) · **Import:** `@rangojs/router/testing` · **DSL it tests:** `middleware()` (see `/middleware`)

`runMiddleware` executes your chain through the router's REAL `executeLoaderMiddleware`, so `next()`, return-Response and throw-Response short-circuits, double-next guards, and header/cookie merge are production-identical. You SEED the request and any prior-middleware state (`vars`, `params`, `env`, `routeMap`); everything else (cookie/header merge, request-context resolution) is real machinery.

## API

### Options — `RunMiddlewareOptions<TEnv>`

| Field           | Type                                                   | Meaning                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`       | `Request \| string`                                    | The request the chain runs under: a `Request`, or a URL string (absolute or path). Optional — defaults to `http://localhost/`; pass it for path-, header-, or cookie-driven middleware.                                                                                               |
| `env`           | `TEnv`                                                 | Environment bindings surfaced as `ctx.env`. Your seam for doubling platform bindings (see `./bindings.md`).                                                                                                                                                                           |
| `params`        | `Record<string, string>`                               | Route params surfaced as `ctx.params`.                                                                                                                                                                                                                                                |
| `vars`          | `VarsInit`                                             | Variables a prior middleware would have set (object form, or `[key, value]` tuples where `key` may be a `createVar()` handle).                                                                                                                                                        |
| `routeMap`      | `Record<string, string>`                               | Route name -> pattern map enabling `ctx.reverse()`.                                                                                                                                                                                                                                   |
| `routeName`     | `string`                                               | Matched route name surfaced as `ctx.routeName`. Does NOT enable scoped `.name` reverse: the chain's `reverse` is deliberately map-only, matching production app/response middleware.                                                                                                  |
| `basename`      | `string`                                               | Router basename surfaced on the context (drives `redirect()` prefixing).                                                                                                                                                                                                              |
| `theme`         | `ThemeConfig \| true`                                  | Theme config in the `createRouter({ theme })` shape; enables `ctx.theme`.                                                                                                                                                                                                             |
| `next`          | `() => Promise<Response>`                              | Terminal handler invoked when the chain calls `next()` all the way through. Defaults to a 200 empty Response. Use it to model the downstream route/handler response.                                                                                                                  |
| `cacheStore`    | `SegmentCacheStore`                                    | Cache store backing any `use cache` function a middleware invokes. Without it, `registerCachedFunction` bypasses, so the cached fn runs uncached and its taint/profile guards never fire.                                                                                             |
| `cacheProfiles` | `Record<string, CacheProfile>`                         | Cache profiles in the `createRouter({ cacheProfiles })` shape.                                                                                                                                                                                                                        |
| `stateCookie`   | `StateCookieSeed` (`{ prefix?, routerId?, version? }`) | Customize the rango state cookie a middleware calling `invalidateClientCache()` rotates (the name is always seeded — default `rango-state_router_0`). Assert via the `Set-Cookie` on `result.response` / `result.cookies`, or against `result.stateCookieName` (without recomputing). |

### Context — `MiddlewareContext` (what your code receives)

The `ctx` your middleware reads. Notable fields:

| Field                       | Type                    | Meaning                                                                            |
| --------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `params`                    | `TParams`               | URL params from `opts.params`.                                                     |
| `env`                       | `TEnv`                  | Bindings from `opts.env`.                                                          |
| `get` / `set`               | fns                     | Read/write context vars (shared with handlers); `get` resolves what `vars` seeded. |
| `header(name, value)`       | fn                      | Queue a response header before `next()`, or set it directly after.                 |
| `reverse`                   | `ScopedReverseFunction` | URL-from-name. Map-only (no auto-fill); needs `routeMap`.                          |
| `setLocationState(entries)` | fn                      | Attach flash/location state to the response.                                       |
| `theme` / `setTheme`        | `Theme` / fn            | Current theme; `undefined` unless `theme` is passed.                               |
| `routeName`                 | `string`                | Matched route name (from `opts.routeName`).                                        |

### Returns — `RunMiddlewareResult<TEnv>`

| Field             | Type                      | Meaning                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `response`        | `Response`                | The final Response: the downstream response, or a middleware short-circuit.                                                                                                                                                                                  |
| `ctx`             | `RequestContext<TEnv>`    | The underlying RequestContext (NOT a per-middleware `MiddlewareContext`). Use `ctx.get(...)` for anything the envelope above doesn't surface.                                                                                                                |
| `nextCalled`      | `number`                  | Times the terminal handler ran: `0` on short-circuit, `1` on pass-through.                                                                                                                                                                                   |
| `cookies`         | `Record<string, string>`  | Effective cookie view: request cookies merged with chain sets/deletes (last-write-wins), as `{ name: value }`.                                                                                                                                               |
| `headers`         | `Record<string, string>`  | Final response headers as `{ name: value }`, lowercased, EXCLUDING `set-cookie` (use `cookies`).                                                                                                                                                             |
| `locationState`   | `Record<string, unknown>` | Flat `{ key: value }` state set via `setLocationState()` / `redirect({ state })` (empty when none).                                                                                                                                                          |
| `stateCookieName` | `string`                  | The resolved rango state cookie name seeded for the run (default `rango-state_router_0`). Assert a middleware's `invalidateClientCache()` rotation against it without recomputing — parity with `runInRequestContext` / `runLoaderResult` / `renderHandler`. |

## Recipe

```ts
import { describe, it, expect } from "vitest";
import { runMiddleware } from "@rangojs/router/testing";
import type { Middleware } from "@rangojs/router";

const requireUser: Middleware = async (ctx, next) => {
  if (!ctx.get("user")) return new Response(null, { status: 401 });
  return next();
};

describe("requireUser", () => {
  it("passes through when the user is present", async () => {
    const { response, nextCalled } = await runMiddleware(requireUser, {
      request: "/dashboard",
      vars: { user: { id: 1 } }, // object form; or [[key, value]] tuples (key may be a createVar())
    });
    expect(nextCalled).toBe(1);
    expect(response.status).toBe(200);
  });

  it("short-circuits (return OR throw Response) when unauthenticated", async () => {
    const { response, nextCalled } = await runMiddleware(requireUser, {
      request: "/dashboard",
    });
    expect(nextCalled).toBe(0);
    expect(response.status).toBe(401);
  });
});
```

Pass an array to run several in order. Cookies set inside middleware via the standalone `cookies().set(...)` (imported from `@rangojs/router`, NOT a `ctx` method) surface on the result's `cookies` and on the merged response `Set-Cookie`.

## Caveats

- No `handles`/`rendered` option by design: the middleware context has no handle APIs in production — no push (`ctx.use(Handle)` is a handler/loader API) and no post-barrier read (`ctx.get(handle)` is loader-only, and middleware runs BEFORE the render barrier anyway). Read handle data in a loader and test it with `runLoader`; assert loader pushes via `runLoaderResult(...).handlePushes` (see `./handles.md`).
- A COMPONENT route's guard stack cannot be exercised through `dispatch` (it throws on component routes), and `renderToFlightString`/`renderRoute` don't run route middleware. Extract the middleware fn and unit-test it here, or assert the guard stack at e2e.
- Middleware-phase `ctx.reverse` is map-only (no auto-fill from current params), matching production — enable it with `routeMap`. `routeName` only feeds `ctx.routeName`; it does NOT scope `.name` reverse (the chain reverse stays map-only by design).
- `ctx.theme` is `undefined` unless `theme` is passed; `redirect()` does no basename prefixing unless `basename` is seeded.
- Platform bindings are yours to double via `env` (see `./bindings.md`).

## See also

- `/middleware` — the DSL this tests
- Siblings: `./response-routes.md`, `./server-actions.md`, `./loader.md`, `./bindings.md`
- Long-form prose: [docs/testing.md](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/testing.md) — section "Middleware"
