# Testing a route handler — renderHandler

**Layer:** RSC unit (react-server project) · **Import:** `@rangojs/router/testing/flight` · **DSL it tests:** a route handler `(ctx) => rsc` (see `/route`)

A Rango route handler is a pure function `(ctx) => rsc` — the function you pass to `path("/p/:slug", ProductPage)`, NOT a component. `renderHandler` runs it with the REAL `HandlerContext` the router builds at runtime (so `ctx.params`, `ctx.use(Loader)`, `ctx.use(Meta)`, `ctx.reverse`, `ctx.get`, response headers via `ctx.headers`, and the standalone `cookies()` all work), serializes the returned RSC, and deserializes it to an inspectable tree. The render and effects are real; loaders are SEEDED (no real loader runs — same model as `runLoader`).

## API

### Options — `RenderHandlerOptions`

| Field                  | Type                                                   | Meaning                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `params`               | `Record<string, string>`                               | Route params surfaced as `ctx.params`.                                                                                                                                                                                                                                                                                                                                               |
| `env`                  | `TEnv`                                                 | Environment bindings surfaced as `ctx.env`.                                                                                                                                                                                                                                                                                                                                          |
| `request`              | `Request \| string`                                    | Backing Request (string or `Request`); defaults to a localhost GET.                                                                                                                                                                                                                                                                                                                  |
| `headers`              | `HeadersInit`                                          | Request headers (e.g. `Cookie`) the handler reads via `cookies()`.                                                                                                                                                                                                                                                                                                                   |
| `vars`                 | `VarsInit` (object or `[[Var, value]]` tuples)         | Variables a prior middleware set, read via `ctx.get(...)`.                                                                                                                                                                                                                                                                                                                           |
| `routeName`            | `string`                                               | Matched route name (drives `ctx.routeName` and scoped reverse).                                                                                                                                                                                                                                                                                                                      |
| `routeMap`             | `Record<string, string>`                               | Route name -> pattern map enabling `ctx.reverse()`.                                                                                                                                                                                                                                                                                                                                  |
| `loaders`              | `ReadonlyArray<readonly [LoaderDefinition, unknown]>`  | Seed the data `ctx.use(SomeLoader)` returns. Matched by loader reference; NO real loader runs.                                                                                                                                                                                                                                                                                       |
| `clientComponents`     | `Record<string, unknown>`                              | `"use client"` components in the handler's RSC, so they serialize as real boundaries when `rangoUseClientTransform()` is not wired. Keyed by name.                                                                                                                                                                                                                                   |
| `stateCookie`          | `StateCookieSeed` (`{ prefix?, routerId?, version? }`) | Customize the rango state cookie a handler calling `invalidateClientCache()` rotates. The name is ALWAYS seeded (default `rango-state_router_0`) so the rotation `Set-Cookie` fires like production rather than no-opping; override `prefix`/`routerId` to match your `createRouter({ stateCookiePrefix, id })`, or `version` (the value is `{version}:{timestamp}`, default `"0"`). |
| `cacheStore`           | `SegmentCacheStore`                                    | Segment cache store backing a `"use cache"` function the handler invokes (e.g. `new MemorySegmentCacheStore()`). WITHOUT it, `registerCachedFunction` takes the uncached bypass and the cached path is NOT exercised (the runtime emits a one-time warning under the test runner). Pair with `cacheProfiles`.                                                                        |
| `cacheProfiles`        | `Record<string, CacheProfile>`                         | Cache profiles in the `createRouter({ cacheProfiles })` shape, required for `"use cache: profileName"` resolution once a `cacheStore` is wired.                                                                                                                                                                                                                                      |
| `inActionRevalidation` | `boolean`                                              | Render as if inside a server action's revalidation render (production sets this in `revalidateAfterAction`). A stale `"use cache"` entry whose profile sets `foregroundOnAction: true` then re-executes in the FOREGROUND (fresh result in this render) instead of SWR. Pair with `cacheStore` + `cacheProfiles` to exercise the opt-in.                                             |

### Context — `HandlerContext` (what your handler receives)

| Field              | Type                                 | Meaning                                                                                        |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `params`           | `Record<string, string>`             | The seeded route params.                                                                       |
| `env`              | `TEnv`                               | The seeded environment bindings.                                                               |
| `request`          | `Request`                            | The backing request.                                                                           |
| `searchParams`     | `URLSearchParams`                    | Parsed query of `request.url`.                                                                 |
| `pathname`         | `string`                             | Pathname of `request.url`.                                                                     |
| `url`              | `URL`                                | Parsed `request.url`.                                                                          |
| `routeName`        | `string \| undefined`                | The matched route name (from `routeName`).                                                     |
| `use`              | `(loaderOrHandle) => data \| pushFn` | A loader returns its seeded data; a handle returns a push fn that RECORDS to `result.handles`. |
| `reverse`          | `(name, params?) => string`          | Build a URL from `routeMap`.                                                                   |
| `get`              | `(Var) => value`                     | Read a seeded `vars` variable.                                                                 |
| `headers`          | `Headers`                            | Response headers; set via `ctx.headers.set(...)` (merged into `result.response`).              |
| `setLocationState` | `(entries) => void`                  | Set location state (surfaced on `result.locationState`).                                       |
| `waitUntil`        | `(fn: () => Promise<void>) => void`  | Register background work.                                                                      |

### Returns — `RenderHandlerResult`

| Field             | Type                      | Meaning                                                                                                                                                             |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tree`            | `unknown`                 | Deserialized RSC the handler returned; `undefined` when it returned/threw a `Response`. Inspect with `findClientBoundaries`.                                        |
| `flight`          | `string \| undefined`     | Raw Flight wire string; `undefined` on a `Response`.                                                                                                                |
| `thrown`          | `unknown`                 | The value the handler THREW (a `redirect()`/`notFound()` Response), captured not re-thrown.                                                                         |
| `response`        | `Response`                | Merged Response (status + headers + Set-Cookie), folding a thrown/returned redirect with accumulated effects.                                                       |
| `cookies`         | `Record<string, string>`  | Effective cookie view after the handler ran.                                                                                                                        |
| `headers`         | `Record<string, string>`  | Response headers (excludes set-cookie; includes a redirect `Location`). The `keepClientCache()` directive shows here as `x-rango-keep-cache: "1"`.                  |
| `stateCookieName` | `string`                  | The resolved rango state cookie name this run seeded (default `rango-state_router_0`). Assert an `invalidateClientCache()` rotation against it without recomputing. |
| `locationState`   | `Record<string, unknown>` | Location state the handler set (`ctx.setLocationState`/`redirect({ state })`).                                                                                      |
| `handles`         | `Map<Handle, unknown[]>`  | What the handler pushed via `ctx.use(Handle)(...)` (e.g. `Meta`, `Breadcrumbs`), keyed by handle.                                                                   |

## Recipe

```tsx
import {
  renderHandler,
  findClientBoundaries,
} from "@rangojs/router/testing/flight";
import { ProductPage } from "../src/pages/product"; // the real handler: (ctx) => rsc
import { ProductLoader } from "../src/loaders/product";
import { Tenant } from "../src/middleware/tenant";
import { Meta } from "../src/handles";

it("renders the product page for a tenant", async () => {
  const { tree, handles } = await renderHandler(ProductPage, {
    params: { slug: "wine" },
    loaders: [[ProductLoader, { name: "Wine", price: 9 }]], // seeds ctx.use(ProductLoader)
    vars: [[Tenant, { name: "Acme" }]], // seeds ctx.get(Tenant)
    routeMap: { product: "/p/:slug" }, // enables ctx.reverse
  });

  expect(JSON.stringify(tree)).toContain("Wine");
  const [counter] = findClientBoundaries(tree, "Counter"); // islands inspectable too
  expect(handles.get(Meta)).toEqual([{ title: "Wine - Shop" }]); // ctx.use(Meta) pushes
});

it("captures a guarded redirect", async () => {
  const { thrown, response } = await renderHandler(ProductPage, {
    params: { slug: "missing" },
    loaders: [[ProductLoader, null]],
  });

  expect(thrown).toBeInstanceOf(Response); // throw redirect() is captured, not re-thrown
  expect(response.status).toBe(302);
});

it("asserts the client-cache directives", async () => {
  // invalidateClientCache() rotates the state cookie -> a Set-Cookie on response.
  const { response, stateCookieName } = await renderHandler(LogoutPage);
  expect(
    response.headers
      .getSetCookie()
      .some((c) => c.startsWith(stateCookieName + "=")),
  ).toBe(true);

  // keepClientCache() sets the suppression directive header (no cookie).
  const { headers } = await renderHandler(QuietPage);
  expect(headers["x-rango-keep-cache"]).toBe("1");
});
```

## Caveats

- An unseeded `ctx.use(loader)` REJECTS with a setup error — seed every dependency via `{ loaders: [[OtherLoader, data]] }`, matched by reference. Loaders are SEEDED, not executed (same as `runLoader`).
- Same alias requirement as flight tests: without the `@rangojs/router -> index.rsc.ts` alias (see [`./setup.md`](./setup.md)), a handler reading `getRequestContext()`/`cookies()` hits the throwing out-of-react-server stub. Symptom: `tree: undefined` with the stub error on `thrown`.
- A `throw redirect()` is captured on `thrown` (with `tree` undefined, since it produced a `Response`) — assert on `thrown`/`response`, no try/catch needed.
- No hydration and no interaction — for clicks, forms, and navigation use e2e.
- `renderHandler` runs a handler FUNCTION `(ctx) => rsc`; for a plain ELEMENT `<Page/>` use `renderServerTree` (see [`./server-tree.md`](./server-tree.md)).
- A handler that calls a `"use cache"` function runs UNCACHED unless you seed `cacheStore` (and `cacheProfiles` for a named profile). With nothing seeded the runtime bypasses to the live body and warns once under the test runner — assert real cache behavior by passing `{ cacheStore: new MemorySegmentCacheStore(), cacheProfiles: { default: { ttl: 60 } } }`.

## See also

- `/route` — the DSL this tests
- Siblings: [`./server-tree.md`](./server-tree.md), [`./server-actions.md`](./server-actions.md), [`./setup.md`](./setup.md), [`./loader.md`](./loader.md)
- Long-form prose: [docs/testing.md](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/testing.md) — section "renderHandler — run a real route handler and assert its RSC"
