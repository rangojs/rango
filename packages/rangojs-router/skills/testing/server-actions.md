# Testing a server action — runInRequestContext

**Layer:** unit (node) · **Import:** `@rangojs/router/testing` · **DSL it tests:** `"use server"` action (see `/server-actions`)

`runInRequestContext(fn, opts)` builds a real `RequestContext` (the same `createRequestContext` the RSC handler uses) AND enters it around `fn`, so an action that calls `getRequestContext()` / `cookies()` / `ctx.get(var)` runs with production fidelity. You SEED the request, env, and vars; the REAL machinery is cookie/header accumulation, location-state, and redirect/notFound throwing.

## API

### Options — `CreateTestContextOptions<TEnv>`

| Field           | Type                                                   | Meaning                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`           | `TEnv`                                                 | Platform bindings the action reads (`ctx.env`). Default `{}`. Double them yourself (see `./bindings.md`).                                                                                                                                                                                                                                             |
| `request`       | `Request \| string`                                    | The request to run under. A `string` becomes `new Request(url)`; pass a full `Request` to seed a `Cookie` header. Default origin `http://localhost/`.                                                                                                                                                                                                 |
| `requestInit`   | `RequestInit`                                          | Init merged when `request` is a string (e.g. `{ method, headers, body }`).                                                                                                                                                                                                                                                                            |
| `variables`     | `Record<string, unknown>`                              | Raw backing store for `ctx.get()` / `ctx.set()`, pre-seeded from `vars`.                                                                                                                                                                                                                                                                              |
| `vars`          | `VarsInit`                                             | Vars a prior middleware would have set (object or `[token, value]` list).                                                                                                                                                                                                                                                                             |
| `routeMap`      | `Record<string, string>`                               | Route name -> pattern map enabling `ctx.reverse()` without global state.                                                                                                                                                                                                                                                                              |
| `routeName`     | `string`                                               | Current route name (drives `ctx.reverse()` self-references).                                                                                                                                                                                                                                                                                          |
| `params`        | `Record<string, string>`                               | Route params on `ctx.params`.                                                                                                                                                                                                                                                                                                                         |
| `basename`      | `string`                                               | Router basename, normalized exactly like `createRouter({ basename })`; drives `redirect()` prefixing. Default `undefined`.                                                                                                                                                                                                                            |
| `cacheStore`    | `SegmentCacheStore`                                    | Backing store for `use cache` functions (same shape as `createRouter({ cache })`). Without it, cached functions run uncached and their guards never fire.                                                                                                                                                                                             |
| `cacheProfiles` | `Record<string, CacheProfile>`                         | Profiles for `use cache: "name"`, same shape as `createRouter({ cacheProfiles })`. An unknown profile throws.                                                                                                                                                                                                                                         |
| `theme`         | `ThemeConfig \| true`                                  | Theme config (same shape as `createRouter({ theme })`). Without it `ctx.theme` / `ctx.setTheme` are inert.                                                                                                                                                                                                                                            |
| `stateCookie`   | `StateCookieSeed` (`{ prefix?, routerId?, version? }`) | Customize the rango state cookie an action calling `invalidateClientCache()` rotates. The name is ALWAYS seeded (default `rango-state_router_0`) so the rotation `Set-Cookie` fires like production; override `prefix`/`routerId` to match `createRouter({ stateCookiePrefix, id })`, or `version` (value is `{version}:{timestamp}`, default `"0"`). |

### Context — `RequestContext<TEnv>` (what your code receives)

`fn` receives `ctx`, the full entered `RequestContext`; the same object resolves via `getRequestContext()` inside `fn`. Notable fields:

| Field                          | Type                     | Meaning                                                                                                                                                                                                           |
| ------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`                          | `TEnv`                   | The seeded platform bindings.                                                                                                                                                                                     |
| `request`                      | `Request`                | The concrete request the run is bound to.                                                                                                                                                                         |
| `cookies()`                    | `Record<string, string>` | @internal effective cookie view. To read or queue cookies inside the action, use the standalone `cookies()` from `@rangojs/router` (`cookies().get(name)` / `cookies().set(...)`), which returns a `CookieStore`. |
| `get(token)` / `set(token, v)` | accessor                 | Read/write request-scoped vars (seeded from `vars` / `variables`).                                                                                                                                                |
| `params`                       | `Record<string, string>` | Seeded route params.                                                                                                                                                                                              |
| `reverse(name, params?)`       | function                 | Build a URL from `routeMap` (when seeded).                                                                                                                                                                        |
| `header(name, value)`          | function                 | Queue a response header.                                                                                                                                                                                          |
| `setLocationState(...)`        | function                 | Set the flash / location state the client reads.                                                                                                                                                                  |
| `theme`/`setTheme`             | —                        | Theme accessors, inert unless `theme` is seeded.                                                                                                                                                                  |

### Returns — `RunInRequestContextResult<T>`

| Field             | Type                      | Meaning                                                                                                                                                                                           |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result`          | `T \| undefined`          | `fn`'s awaited return, or `undefined` if it threw.                                                                                                                                                |
| `thrown`          | `unknown`                 | What `fn` threw (a redirect / `notFound` `Response` on the success path), or `undefined`. Captured, NOT re-thrown — assert on it.                                                                 |
| `response`        | `Response`                | The merged `Response` (status + headers + Set-Cookie). On a thrown redirect, that redirect's `Location` merged with the accumulated cookies/headers.                                              |
| `cookies`         | `Record<string, string>`  | Effective cookie view: request cookies + run mutations, last-write-wins.                                                                                                                          |
| `headers`         | `Record<string, string>`  | Response headers the run set (plus a thrown redirect's `Location`), EXCLUDING `set-cookie` (use `cookies`). Names lowercased. A `keepClientCache()` call shows here as `x-rango-keep-cache: "1"`. |
| `stateCookieName` | `string`                  | The resolved rango state cookie name this run seeded (default `rango-state_router_0`). Assert an `invalidateClientCache()` rotation against it without recomputing.                               |
| `locationState`   | `Record<string, unknown>` | The flash set via `ctx.setLocationState()` / `redirect({ state })`, as the flat `{ key: value }` the client reads.                                                                                |

Low-level variant: when you already hold a context from `createTestRequestContext(opts)`, call `runWithRequestContext(ctx, fn)` (re-exported from `@rangojs/router/testing`) to enter it directly. `runInRequestContext` is the one-call convenience over `createTestRequestContext` + `runWithRequestContext`.

## Recipe

```ts
import { it, expect } from "vitest";
import { runInRequestContext } from "@rangojs/router/testing";
import { loginAction } from "../src/actions/login"; // sets a session cookie + flash, then throw redirect("/app")

it("sets the session cookie + flash and redirects", async () => {
  const { thrown, cookies, locationState } = await runInRequestContext(
    () => loginAction(input),
    {
      env,
      request: new Request("https://app.test/admin", {
        headers: { Cookie: "sid=abc" },
      }),
    },
  );
  expect((thrown as Response).headers.get("Location")).toBe("/app"); // redirected
  expect(cookies.session).toBeDefined(); // cookie set before the throw, no @internal cast
  expect(locationState).toEqual({ flash: { text: "Welcome back" } });
});

it("asserts the client-cache directives an action issued", async () => {
  // invalidateClientCache() rotates the state cookie -> a Set-Cookie on response.
  const { response, stateCookieName } = await runInRequestContext(() =>
    logoutAction(),
  );
  expect(
    response.headers
      .getSetCookie()
      .some((c) => c.startsWith(stateCookieName + "=")),
  ).toBe(true);

  // keepClientCache() sets the suppression directive header (no cookie).
  const { headers } = await runInRequestContext(() => dismissBannerAction());
  expect(headers["x-rango-keep-cache"]).toBe("1");
});
```

## Caveats

- The snapshot fires whether `fn` RETURNS or THROWS. A `throw redirect("/app")` on the success path is captured on `thrown` (NOT re-thrown), so no try/catch is needed; assert on `thrown` for a throwing action.
- There is no cookies / headers option. Seed a request cookie by passing a full `Request` with the `Cookie` header (as in the recipe).
- `runWithRequestContext(ctx, fn)` is the low-level entry when you already hold a context; `runInRequestContext` is the one-call convenience over `createTestRequestContext` + `runWithRequestContext`.
- Platform bindings are yours to double via `env` (see `./bindings.md`).

## See also

- `/server-actions` — the DSL this tests
- Siblings: `./render-handler.md`, `./middleware.md`, `./loader.md`, `./bindings.md`
- Long-form prose: [docs/testing.md](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/testing.md) — section "runInRequestContext — the handler / server-action test primitive"
