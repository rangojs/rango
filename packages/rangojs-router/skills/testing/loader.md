# Testing a loader — runLoader

**Layer:** unit (node) · **Import:** `@rangojs/router/testing` · **DSL it tests:** `loader()` (see `/loader`)

`runLoader` runs a loader against a real `RequestContext` (cookies, headers, `ctx.get`, `ctx.reverse` all resolve) in plain node — that machinery is REAL; what you SEED is the params, env, vars, search, route map, and any `ctx.use` dependency data. Pass a registered `createLoader()` handle (its fn is recovered from the registry) or the raw async body `(ctx) => ...`.

## API

### Options — `RunLoaderOptions<TEnv>`

| Field           | Type                                                            | Meaning                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `params`        | `Record<string, string>`                                        | Route params; surfaced as `ctx.params` and `ctx.routeParams`.                                                                                                                                                   |
| `search`        | `Record<string, string>`                                        | Search params; merged into the request URL so `ctx.searchParams` reflects them.                                                                                                                                 |
| `searchData`    | `Record<string, unknown>`                                       | The TYPED `ctx.search` object a route's search schema would produce. Distinct from `search` (which sets the raw `ctx.searchParams`).                                                                            |
| `basename`      | `string`                                                        | Router basename surfaced on the context; drives `redirect()` prefixing.                                                                                                                                         |
| `theme`         | `ThemeConfig \| true`                                           | Theme config in the `createRouter({ theme })` shape (e.g. `true` or `{ themes: [...] }`). Without it `ctx.theme`/`ctx.setTheme` are inert.                                                                      |
| `env`           | `TEnv`                                                          | Environment bindings surfaced as `ctx.env`.                                                                                                                                                                     |
| `request`       | `Request \| string`                                             | Override the backing Request. Defaults to a localhost GET.                                                                                                                                                      |
| `vars`          | `VarsInit`                                                      | Variables a prior middleware would have set (object `{ key: value }`, or `[key, value]` tuples where the key may be a `createVar()` handle).                                                                    |
| `routeMap`      | `Record<string, string>`                                        | Route name -> pattern map enabling `ctx.reverse()`.                                                                                                                                                             |
| `routeName`     | `string`                                                        | Matched route name for scoped `.name` reverse resolution.                                                                                                                                                       |
| `method`        | `string`                                                        | HTTP method surfaced as `ctx.method`. Defaults to `"GET"`.                                                                                                                                                      |
| `body`          | `unknown`                                                       | Request body surfaced as `ctx.body`.                                                                                                                                                                            |
| `formData`      | `FormData`                                                      | Form data surfaced as `ctx.formData` (exposed verbatim; no multipart parsing).                                                                                                                                  |
| `loaders`       | `ReadonlyArray<readonly [LoaderDefinition<any, any>, unknown]>` | Seed `ctx.use(OtherLoader)` by REFERENCE as `[[OtherLoader, data]]` tuples (same shape as `renderHandler`/`renderRoute`). Checked before `use`.                                                                 |
| `use`           | `UseResolver`                                                   | Dynamic resolver for `ctx.use(OtherLoader)` composition. `loaders` wins when both match.                                                                                                                        |
| `cacheStore`    | `SegmentCacheStore`                                             | Cache store backing `use cache` functions. Without one, a cached function bypasses and runs uncached (its taint/profile guards never fire).                                                                     |
| `cacheProfiles` | `Record<string, CacheProfile>`                                  | Cache profiles, the `createRouter({ cacheProfiles })` shape.                                                                                                                                                    |
| `stateCookie`   | `StateCookieSeed` (`{ prefix?, routerId?, version? }`)          | Customize the rango state cookie a loader calling `invalidateClientCache()` rotates (the name is always seeded — default `rango-state_router_0`).                                                               |
| `rendered`      | `boolean \| (() => void \| Promise<void>)`                      | Mock the `ctx.rendered()` render barrier so a loader that `await ctx.rendered()`s can be unit-tested. By default `ctx.rendered()` throws. `true` resolves immediately; a function controls timing/side effects. |
| `handles`       | `ReadonlyArray<readonly [Handle<any, any>, unknown]>`           | Seed the values `ctx.get(SomeHandle)` returns — the ACCUMULATED handle data read after `await ctx.rendered()`. Matched by handle reference. (Loader handle WRITES need no seed — see `runLoaderResult(...).handlePushes`.) |

### Context — `TestLoaderContext<TEnv>` (what your loader receives)

| Field              | Type                                                                                      | Meaning                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `params`           | `Record<string, string>`                                                                  | Route params (from `opts.params`).                                                                                                                   |
| `routeParams`      | `Record<string, string>`                                                                  | Same values as `params`.                                                                                                                             |
| `request`          | `Request`                                                                                 | The backing request.                                                                                                                                 |
| `searchParams`     | `URLSearchParams`                                                                         | Raw search params (from `opts.search` baked into the URL).                                                                                           |
| `search`           | `Record<string, unknown>`                                                                 | The TYPED search object (from `opts.searchData`); defaults to `{}`.                                                                                  |
| `pathname`         | `string`                                                                                  | Request pathname.                                                                                                                                    |
| `url`              | `URL`                                                                                     | Request URL.                                                                                                                                         |
| `originalUrl`      | `URL`                                                                                     | Pre-basename-rewrite URL.                                                                                                                            |
| `env`              | `TEnv`                                                                                    | Environment bindings (from `opts.env`).                                                                                                              |
| `get`              | `<T>(contextVar: ContextVar<T>) => T \| undefined` / `<T>(key: string) => T \| undefined` | Read a var seeded via `opts.vars` — or READ a handle: `ctx.get(handle)` is rendered-gated (throws before the barrier) and returns the `opts.handles` seed. |
| `use`              | `(dep) => ...`                                                                            | Resolve `ctx.use(OtherLoader)` (loader seeds, then the `use` resolver, then the real context `use()`) — or WRITE a handle: `ctx.use(SomeHandle)` returns the push function (withDefer-wrapped), recording into `runLoaderResult(...).handlePushes`. |
| `method`           | `string`                                                                                  | HTTP method (from `opts.method`, default `"GET"`).                                                                                                   |
| `body`             | `unknown`                                                                                 | Request body (from `opts.body`).                                                                                                                     |
| `formData`         | `FormData \| undefined`                                                                   | Form data (from `opts.formData`).                                                                                                                    |
| `reverse`          | `(name, params?, search?) => string`                                                      | Build a URL; throws unless `opts.routeMap` was passed.                                                                                               |
| `rendered`         | `() => Promise<void>`                                                                     | The render barrier; throws by default, mocked via `opts.rendered`.                                                                                   |
| `waitUntil`        | `(p: Promise<unknown>) => void`                                                           | Register background work (no-op accounting in tests).                                                                                                |
| `executionContext` | `ExecutionContext \| undefined`                                                           | Platform execution context from the backing request; pairs with `waitUntil`.                                                                         |

### Returns — `Promise<T>`

The loader data DIRECTLY (no envelope). `T` is the loader's return type.

To assert a loader's EFFECTS — a `Set-Cookie`, a response header, a
`throw redirect(...)` or `notFound()` (loader authority signals), or handle
writes — use the sibling **`runLoaderResult(loader, opts)`** instead. Same
options, but it returns an envelope:
`{ result, thrown, response, cookies, headers, locationState, stateCookieName, handlePushes }`
(parity with `runInRequestContext`; `result` is the loader's data;
`handlePushes` records every `ctx.use(SomeHandle)({...})` write in push
order). `runLoader` discards those effects.

## Recipe

```ts
import { runLoader, runLoaderResult } from "@rangojs/router/testing";
import { createLoader, createVar } from "@rangojs/router";

const User = createVar<{ name: string }>();
// The registered loader — no separate body export needed for testability:
const ProductLoader = createLoader(async (ctx) => ({
  id: ctx.params.id,
  region: ctx.env.REGION,
  user: ctx.get(User),
}));

it("reads params, env, and seeded vars", async () => {
  const data = await runLoader(ProductLoader, {
    params: { id: "42" },
    env: { REGION: "eu" },
    vars: [[User, { name: "Ada" }]],
  });
  expect(data).toEqual({ id: "42", region: "eu", user: { name: "Ada" } });
});

it("builds a self link via reverse", async () => {
  // runLoader(async (ctx) => ({ ... }), opts) — the bare body — works identically.
  const data = await runLoader(
    async (ctx) => ({ self: ctx.reverse("product", { id: ctx.params.id }) }),
    { params: { id: "42" }, routeMap: { product: "/products/:id" } },
  );
  expect(data.self).toBe("/products/42");
});

it("asserts a loader's set-cookie + redirect (runLoaderResult)", async () => {
  // AuthLoader validates, sets a `session` cookie, then `throw redirect("/")`.
  const { thrown, response, cookies } = await runLoaderResult(AuthLoader, {
    request: new Request("https://app.test/login?token=ok"),
  });
  expect((thrown as Response).headers.get("Location")).toBe("/");
  expect(cookies.session).toBeDefined();
  expect(
    response.headers.getSetCookie().some((c) => c.startsWith("session=")),
  ).toBe(true);
});
```

## Caveats

- `ctx.reverse(...)` throws unless you pass `routeMap` (and `routeName` for scoped `.name` resolution). It does NOT fall back to the global route map.
- `ctx.rendered()` throws by default (the render barrier only exists in a full match); pass `{ rendered: true }` to mock it for post-barrier logic, and `{ handles: [[SomeHandle, data]] }` to seed the `ctx.get(SomeHandle)` read. `ctx.isAction(...)` is unavailable — cover those at e2e.
- Seeded `loaders` (by-reference tuples) are NOT executed — `ctx.use(OtherLoader)` returns the seeded value. The dynamic `use` resolver, by contrast, IS executed (it is a function called to compute the value). Either way the REAL loader body is not run; real loader execution and side-effects are e2e-only. `loaders` is checked before the `use` resolver.
- A handle imported through the CLIENT build has its body dropped — `runLoader` throws a clear error pointing to the `rangoTestConfig()` preset or the raw body. A router using `Prerender()`/`createLoader()`/`Static()` now constructs in a bare test (each assigns a runtime fallback `$$id`); only the whole router _file_ may still need the plugin (its page modules pull app deps / `virtual:` modules).
- No `cookies`/`headers` option: seed a cookie by passing a full Request with a Cookie header — `{ request: new Request(url, { headers: { Cookie: "sid=abc" } }) }`. (`search`/`method` are baked onto this request for you.)
- `ctx.search` (typed) defaults to `{}`; `opts.search` only sets the raw `ctx.searchParams`. Seed the typed object with `searchData`. (The harness seeds `searchData` verbatim — it does NOT run a typed-search SCHEMA, so schema parsing/validation is e2e.)
- `ctx.theme`/`ctx.setTheme` are NOT on the loader context — theme accessors are handler-only. (The `theme` option seeds the underlying request context for `use cache` theme resolution, but a loader body cannot read theme.) `redirect()` does no basename prefixing unless you seed `basename`.
- Platform bindings are yours to double via `env` (see `./bindings.md`).

## See also

- `/loader` — the DSL this tests
- Siblings: `./handles.md`, `./reverse-and-types.md`, `./bindings.md`, `./server-actions.md`
- Long-form prose: [docs/testing.md](https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/testing.md) — section "Loaders — the raw body or a registered createLoader"
