---
name: testing
description: Test @rangojs/router apps — unit (loaders/middleware/reverse/components), integration (dispatch/Flight), and e2e (dev+prod parity, progressive enhancement)
argument-hint: [layer]
---

# Testing @rangojs/router apps

Rango ships six consumer-facing testing entries, one per test runtime/dependency:
`@rangojs/router/testing` (unit + integration, under a Vite-driven Vitest
project), `@rangojs/router/testing/vitest` (the `rangoTestConfig`/`rangoTestAliases` setup preset),
`@rangojs/router/testing/dom` (`renderRoute`, needs RTL + a DOM env),
`@rangojs/router/testing/e2e` (the Playwright harness),
`@rangojs/router/testing/flight` (real Flight, react-server condition only), and
`@rangojs/router/testing/flight-matchers` (the Flight matchers).
The hard problem in an RSC app is that the layer you reach for is dictated by
**what the behavior touches** — a pure predicate is a one-line vitest test; a
real async Server Component cannot be a plain node test at all. Pick the layer
**first**, then the primitive. Reaching one layer too high (e2e for a reverse
function) is slow; one too low (a node test for Flight) fails to compile or
silently asserts nothing.

Compatibility (the setup that bit the first installed consumer — read before
writing `vitest.config.ts`):

- **Node >= 23:** use **`rangoTestConfig()`**, not the bare `rangoTestAliases()`.
  `@rangojs/router` is consumed as SOURCE (its exports resolve to `./src/*.ts`),
  and Node >= 23 refuses to type-strip `.ts` under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). `rangoTestConfig` ships as
  compiled JS (so the config itself loads under Node) AND adds the required
  `server.deps.inline: [/@rangojs[/\\]router/]` so Vite — not Node — transpiles
  rango's source under test. With bare `rangoTestAliases` you must wire
  `deps.inline` yourself.
- **Vitest:** the rango fragment goes under `test` (`test.alias` +
  `test.server.deps.inline`, both returned by `rangoTestConfig`). The node/DOM
  project keeps React as its CLIENT build; the Flight project uses the
  `react-server` condition in a separate `vitest.rsc.config.ts`.

For the prose guide with full setup and migration, see
[`docs/testing.md`](https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/testing.md)
(the `docs/` directory is not shipped in the published package, so this is an
absolute link).

## When to use

Use this skill when adding or changing tests for a Rango app: a loader,
middleware, a route map, a client component, a response route, cache/SWR
behavior, prerender, or a navigation/PE flow.

Two non-negotiable mandates (from the repo's `CLAUDE.md`, and they apply to
consumer apps too):

- **Every e2e covers BOTH dev and production.** A dev-only e2e is not
  acceptable. Use `parityDescribe` — it generates the dev and production
  describes from one body, so you cannot forget the prod half.
- **Progressive-enhancement parity** is a first-class assertion. A form-driven
  flow must produce the same observable result with JS on and JS off. Use
  `expectParity`.

## The read-first shape

Four import roots, each matched to the dependency/runtime that can load it —
this split is forced by hard walls, not preference:

- `@rangojs/router/testing` — unit + integration primitives. Run these under a
  **Vite-driven Vitest** project with the rango Vite plugin active (the router
  internals import the `@rangojs/router:version` virtual module; without the
  plugin, alias `@rangojs/router:version`). It references neither React,
  `@testing-library/react`, Playwright, nor the RSC runtime — a unit suite
  testing only loaders/middleware/`dispatch` pulls in none of them.
- `@rangojs/router/testing/dom` — `renderRoute` (the RTL component stub). Kept
  separate so the unit barrel above stays free of React/RTL; it lazy-loads
  `@testing-library/react` at call time and needs a DOM env (happy-dom/jsdom).
- `@rangojs/router/testing/e2e` — the Playwright harness. Kept separate so it
  loads in a plain (non-Vite) Playwright runner; the unit barrel pulls in
  router-manifest code that a Playwright loader cannot resolve. The helpers take
  your `test`/`expect` as parameters, so this entry never imports
  `@playwright/test` at runtime.
- `@rangojs/router/testing/flight` — real Flight rendering. Its serializer loads
  only under the `react-server` node condition; pulling it elsewhere throws.

The single rule that drives everything:

> **If the behavior needs a real Flight render, it cannot be a plain vitest node
> test.** It is either `renderToFlightString` (under the react-server vitest
> project) or an e2e test. There is no middle ground in node.

## Decision tree: behavior -> layer -> primitive

| The behavior is…                                                                                          | Layer        | Primitive                                                        | Import root                      |
| --------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------- | -------------------------------- |
| a pure function / `reverse` / a predicate (`revalidate`, `isAction`)                                      | unit (node)  | call it directly; `runMiddleware`/`runLoader` for ctx            | `@rangojs/router/testing`        |
| one loader's data logic                                                                                   | unit (node)  | `runLoader` (a registered `createLoader` handle, or the raw fn)  | `@rangojs/router/testing`        |
| one middleware's ordering / short-circuit / cookie+header merge                                           | unit (node)  | `runMiddleware`                                                  | `@rangojs/router/testing`        |
| a CLIENT component reading router context (`useParams`/`useReverse`/`Outlet`/`useNavigation`/`useLoader`) | unit (DOM)   | `renderRoute` (needs happy-dom/jsdom + `@testing-library/react`) | `@rangojs/router/testing/dom`    |
| a redirect / status / headers / cookies / **response route** (json/text/html/xml/md), no Flight           | integration  | `dispatch` (router -> Response)                                  | `@rangojs/router/testing`        |
| a real async **Server Component** / Flight serialization shape                                            | RSC unit     | `renderToFlightString` + `toMatchFlight`                         | `@rangojs/router/testing/flight` |
| a client island's **typed props** across the boundary / inlined-vs-island                                 | RSC unit     | `renderServerTree` + `findClientBoundaries`                      | `@rangojs/router/testing/flight` |
| a real route **handler** `(ctx) => rsc` (params/loaders/vars -> rendered RSC + effects)                   | RSC unit     | `renderHandler` (seeded `HandlerContext`)                        | `@rangojs/router/testing/flight` |
| navigation, hydration, PE parity, view transitions, real SSR                                              | e2e          | `createRangoE2E` -> `parityDescribe`/`expectParity`              | `@rangojs/router/testing/e2e`    |
| cache hit/miss/stale, prerender (= a cache hit by design)                                                 | e2e + signal | `assertCacheStatus` / telemetry sink (gate on)                   | `@rangojs/router/testing`        |
| generated route map drift vs runtime                                                                      | unit (node)  | `assertGeneratedRoutesMatch`                                     | `@rangojs/router/testing`        |

Cross-references: `/loader`, `/middleware`, `/server-actions`, `/caching`,
`/prerender`, `/typesafety`.

## Unit recipes (vitest, node)

### runMiddleware — ordering, short-circuit, cookie/header merge

Runs the chain through the router's **real** `executeMiddleware`, so
`next()`, return-Response short-circuit, throw-Response short-circuit,
double-next guards, and header/cookie merging behave exactly as in production.
`nextCalled` is `0` on short-circuit, `1` on pass-through. The result also
carries `cookies` (the effective `{ name: value }` view — assert a cookie the
chain set without casting through the `@internal` `ctx.cookies()`). The returned
`ctx` is the underlying `RequestContext` for anything else (`ctx.get(...)`,
`ctx.res.headers`).

```ts
import { describe, it, expect } from "vitest";
import { runMiddleware } from "@rangojs/router/testing";
import type { Middleware } from "@rangojs/router";

const requireUser: Middleware = async (ctx, next) => {
  if (!ctx.get("user")) return new Response(null, { status: 401 });
  return next();
};

it("passes through when the user is present", async () => {
  const { response, nextCalled } = await runMiddleware(
    requireUser,
    "/dashboard",
    {
      vars: { user: { id: 1 } }, // object form; or [[key, value]] tuples (key may be a createVar())
    },
  );
  expect(nextCalled).toBe(1);
  expect(response.status).toBe(200);
});

it("short-circuits (return OR throw Response) when unauthenticated", async () => {
  const { response, nextCalled } = await runMiddleware(
    requireUser,
    "/dashboard",
  );
  expect(nextCalled).toBe(0);
  expect(response.status).toBe(401);
});
```

Seed prior-middleware state with `vars` (string key or `createVar()` handle).
Model the downstream route with `next`. Enable `ctx.reverse(...)` by passing
`routeMap` (and `routeName` for scoped `.name` resolution). Pass an array to run
several in order. Cookies set via `cookies().set(...)` surface on the result's
`cookies` and on the merged response `Set-Cookie`.

There is no `handles`/`rendered` option (only `runLoader` has them): middleware
runs BEFORE the render barrier, so it has no post-barrier handle access in
production — `ctx.use(Handle)` after `ctx.rendered()` is a loader/handler
capability, not a middleware one. Read handle data in a loader and test it with
`runLoader`'s `handles`/`rendered`.

### runLoader — one loader's data logic

Pass a registered `createLoader()` handle **or** the raw loader body `(ctx) => ...`.
A handle's fn is recovered from the registry: `createLoader` assigns a
runtime-fallback `$$id` and registers the fn even without the Vite plugin, when
imported through the server build (`@rangojs/router` under the `rangoTestConfig`
preset). The raw body needs no build at all. Either way `runLoader` invokes the
function against a real `RequestContext`, so cookies, headers, `ctx.get`, and
`ctx.reverse` resolve. (A handle imported through the CLIENT build has its body
dropped — `runLoader` then throws a clear error pointing you to the preset or the
raw body.)

```ts
import { runLoader } from "@rangojs/router/testing";
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
// runLoader(async (ctx) => ({ ... }), opts) — the bare body — works identically.
```

Options: `params` (also surfaced as `routeParams`), `search`, `env`, `vars`,
`method`/`body`/`formData`, `routeMap`/`routeName` (for `ctx.reverse`), and
`use` (a resolver for `ctx.use(OtherLoader)` composition — without it, `ctx.use`
runs the dependency's own `fn` if it carries one).

Two unit-only limitations to document in your test, not work around:

- `ctx.reverse(...)` **throws** unless you pass `routeMap`.
- `ctx.rendered()` **throws** (the DSL render barrier only exists in a full
  match) and `ctx.isAction(...)` (the action-render context) is not available —
  test those with `renderToFlightString` or e2e.

No body extraction needed: `export const L = createLoader(async (ctx) => {...})`
can be imported and passed straight to `runLoader(L, ...)`. Exporting the inner
body separately is optional now (only if you want to test it without going
through `createLoader` at all).

COOKIE SEEDING: there is no `cookies`/`headers` option — seed a request cookie by
passing a full `Request` with the header, `runLoader(body, { request: new
Request("https://app.test/", { headers: { Cookie: "sid=abc" } }) })`. A loader
that reads `cookies()` then sees `abc`. (`search`/`method` are baked onto this
request for you, so pass a `Request` only when you need headers/cookies.)

### runInRequestContext — an action (or any fn) that reads request context

For a server ACTION (or any function) that authenticates off the request cookie
and calls `getRequestContext()` / `cookies()` but has no loader-context shape,
`runInRequestContext(fn, opts)` builds a real `RequestContext` (same `opts` as the
other primitives — `env`, `request`, `vars`, ...) AND enters it, so the function
runs exactly as in production. `fn` may be async; the context stays active across
its awaits. It captures the action's OUTPUT whether `fn` RETURNS or THROWS, so it
is assertable WITHOUT casting through the `@internal` `ctx.res` / `ctx.cookies()`:

- `result` — fn's return value (awaited), or `undefined` if it threw
- `thrown` — what `fn` threw (a redirect/notFound `Response` on the SUCCESS path), or `undefined`. Captured, NOT re-thrown — assert on it for a throwing action
- `response` — Set-Cookie / headers / status the run set; on a thrown redirect, that redirect's `Location` merged with the cookies
- `cookies` — the effective `{ name: value }` cookie view after the run
- `headers` — the response headers the run set (via `ctx.header(...)`, plus a thrown redirect's `Location`) as a plain `{ name: value }` object, EXCLUDING set-cookie (that's `cookies`); names lowercased. (`runMiddleware` returns the same `headers`.)
- `locationState` — the flash the action set via `ctx.setLocationState()` / `redirect({ state })`, resolved to the `{ key: value }` the client reads

The THROW path matters: the dominant cookie+flash case is an auth action that sets
a cookie + flash then `throw redirect("/app")` on success. Because the snapshot
fires on the throw too, you do NOT have to wrap the action in your own try/catch:

```ts
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
```

For the low-level case where you already hold a context from
`createTestRequestContext(...)`, `runWithRequestContext(ctx, fn)` is re-exported
from `@rangojs/router/testing` to enter it directly; `runInRequestContext` is the
one-call convenience over the two.

### Your bindings are your seam (env.DB / Durable Objects / R2)

The node primitives test the router's seams; the moment your loader/middleware/
action calls a **platform binding** (`env.DB`, a Durable Object stub, `env.R2`),
you have crossed out of rango and into your app's I/O. rango deliberately ships
**no doubles** for these — they are app- and schema-specific — so the double is
yours to build and inject through the `env` option every primitive already takes:

```ts
await runLoader(bundleLoaderBody, { env: { DB: fakeD1 } });
await runMiddleware(requireMembership, "/t/acme/edit", { env: { DB: fakeD1 } });
await runInRequestContext(() => authorizeAction(input), {
  env: { DB: fakeD1 },
  request,
});
```

Plan for this seam — it is usually the single biggest effort in a consumer unit
suite, and the work is in matching the **driver contract**, not the binding's
public API. The sharp edge: a `D1Database` double for **`drizzle-orm/d1`** must
serve **positional row arrays in schema-column order** for drizzle's `.raw()`
path (with the driver-level encodings so the decoder round-trips `Date`/JSON) —
NOT `{ column: value }` objects. A naive object-shaped double returns
silently-wrong or empty rows. That contract is per-method: drizzle-d1 serves
SELECTs through `.raw()` (the positional rows above), but writes
(INSERT/UPDATE/DELETE) go through `.run()`, which returns `{ success, meta }` (no
rows) and bypasses the row responder entirely — model BOTH paths, a read-only
`.raw()` double silently no-ops every write. Keep the double at the binding
boundary; never mock a rango primitive to dodge building it.

### renderRoute — a client component reading router context

RTL-style stub. Peer of React Router's `createRoutesStub` / Expo's
`renderRouter`. It mounts the router's real `NavigationProvider` plus a
synthetic segment tree so `useParams`, `useReverse`, `useNavigation`, `Outlet`,
`usePathname`, `useSearchParams`, and `useLoader`/`useFetchLoader` (reading
**seeded** data) resolve — no server, no Vite, no Flight round-trip. It is
`async` (lazy-loads `@testing-library/react`).

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { Outlet, useParams, useReverse } from "@rangojs/router/client";

afterEach(cleanup);

function Layout() {
  return (
    <div>
      <span data-testid="shell">shell</span>
      <Outlet />
    </div>
  );
}
function Product() {
  const { productId } = useParams<{ productId: string }>();
  const reverse = useReverse({ product: "/products/:productId" });
  return (
    <a data-testid="link" href={reverse("product", { productId: "2" })}>
      {productId}
    </a>
  );
}

it("resolves params + reverse + Outlet through the layout chain", async () => {
  const { getByTestId, router } = await renderRoute(
    [
      { path: "/products", Component: Layout }, // layout (root)
      { path: "/products/:productId", Component: Product }, // leaf (last)
    ],
    { initialUrl: "/products/1" },
  );
  expect(getByTestId("shell").textContent).toBe("shell");
  expect(getByTestId("link").getAttribute("href")).toBe("/products/2");

  await router.navigate("/products/2"); // client-only nav, re-resolves the same routes
  expect(router.pathname()).toBe("/products/2");
});
```

`RenderRouteSpec = { path, Component, layout?, loaderIds?, name? }`. The array
is the layout chain root-to-leaf; the **last** entry is the leaf route. Seed
loader reads with `options.loaderData` keyed by the loader's `$$id`; attach a
loader to a specific layout via that spec's `loaderIds`:

```tsx
const CartLoader = {
  __brand: "loader",
  $$id: "loaders/cart#CartLoader",
} as any;
await renderRoute(
  [
    { path: "/shop", Component: CartLayout, loaderIds: [CartLoader.$$id] },
    { path: "/shop/item", Component: Page },
  ],
  { initialUrl: "/shop/item", loaderData: { [CartLoader.$$id]: { count: 3 } } },
);
```

Seed `useHandle` reads with `handles: [[handle, pushedValues[]]]` and
`useLocationState` with `locationState: [[def, value]]` (both by reference).
Handle data is accumulated GLOBALLY (not segment-scoped like loaders), so a
LAYOUT component reading a handle (a `DetailLayout`/`ActionToolbar` reading
`EditTarget`/`PageEyebrow`) sees the seeded values, not just the leaf route.

Model an `include('/shop', …)` mount with the `mount` option: it wraps the
segment chain in a MountContext exactly as production, so `useMount()` returns
the prefix and `useHref`/`useReverse` resolve mount-prefixed URLs — a
mount-relative subtree (`/c/:slug` mounted under `/shop`) becomes reproducible at
the unit layer instead of e2e-only:

```tsx
await renderRoute([{ path: "/c/wine", Component: PDP }], { mount: "/shop" });
// useMount() -> "/shop"; useReverse({ product: "/c/:slug" })("product", { slug: "wine" }) -> "/shop/c/wine"
```

Don't confuse this with an OPTIONAL param in the matched pattern: `/:locale?/c/:group`
at `/en/c/wine` auto-fills `locale` from the match, so `reverse("group", { group })`
returns `/en/c/group` with NO `mount` needed (production parity — `useReverse`
merges `useParams()`). Use `mount` only for an `include()` prefix; a param-bearing
mount like `include("/:locale?", …)` resolves to a concrete prefix you pass as
`mount: "/en"`. A locale "dropping" from a reversed URL in a test is usually a
missing `mount` seed, not an auto-fill gap.

FIDELITY CAVEAT — this is the **client tree only**. It does NOT catch
server/client boundary reference-identity remount bugs, real Flight
serialization errors, loader execution, middleware, or handler ordering. Those
are `renderToFlightString` / e2e territory. Loader data is seeded, never run.
Needs a DOM env (`// @vitest-environment happy-dom`, or jsdom) and the consumer
must install `@testing-library/react` (optional peer).

CATCH — streaming `use(promise)` Suspense content (e.g. an async breadcrumb
`content: Promise<ReactNode>`): a plain `Promise.resolve(node)` does NOT flush
its Suspense retry in RTL/happy-dom (renderRoute renders internally, not inside
an awaited `act`), so the DOM stays on the fallback. Assert the **pending**
fallback with a never-resolving `new Promise(() => {})`; for the **arrived**
state pass an already-settled promise so `use()` reads it synchronously:
`const p = Promise.resolve(node) as any; p.status = "fulfilled"; p.value = node;`.
The real pending→resolved transition is an e2e concern.

ARIA GOTCHA — query a `<Link>` by `getByRole("link")` only when it renders a bare
anchor. An explicit `role` on the link (e.g. `<Link role="tab">` in a tablist)
OVERRIDES the anchor's implicit `link` role, so `getByRole("link")` finds
nothing — query the explicit role (`getByRole("tab")`) or fall back to
`getByText`/`getByTestId` and assert `getAttribute("href")`.

### Type-level tests — make misuse fail to compile

The reverse/href/params/env types are a real contract; a wrong route name,
missing param, or unknown binding should be a COMPILE error, not a runtime
surprise. This is the highest signal-per-cost test in the suite, but it runs at
typecheck time, not in the vitest runner — so it is its own layer, wired into CI
as a real step (`pnpm run typecheck` / `tsc --noEmit`). Three recipes, smallest
first:

1. Negative assertions with `@ts-expect-error` (a runtime test cannot do this) —
   the directive ERRORS if the line below ever starts compiling, so a regressed
   guard fails the typecheck:

   ```ts
   import { useReverse } from "@rangojs/router/client";
   const reverse = useReverse({ product: "/products/:productId" });
   reverse("product", { productId: "2" }); // ok
   // @ts-expect-error missing required param
   reverse("product", {});
   // @ts-expect-error unknown route name
   reverse("nope", {});
   ```

2. Positive assertions with vitest's `expectTypeOf` — for pinning an INFERRED
   type (a loader's return, a parsed search schema, a handle's accumulated
   shape), in a normal `*.test.ts`:

   ```ts
   import { expectTypeOf } from "vitest";
   expectTypeOf(await runLoader(cartLoaderBody)).toEqualTypeOf<{
     count: number;
   }>();
   ```

3. A dedicated `*.test-d.ts` + `tsconfig.types.json` (extends base, includes only
   those files; run `tsc -p tsconfig.types.json --noEmit`) for a large type
   suite — the pattern rango itself uses for its augmentation contracts. Recipe 1
   is enough for most apps; reach for 3 only when inline assertions clutter
   runtime tests.

## Integration recipes

### dispatch — request -> Response, without Flight

In-process matching + middleware, no RSC render. Covers `308` redirects
(trailing slash etc.) with `Location`, `404`, response routes
(json/text/html/xml/md with content negotiation), and **global + route-level
middleware** short-circuits with full `next()`/throw/header+cookie fidelity. It
reuses the router's own `previewMatch`, so middleware collection is the router's,
not a re-implementation. Hitting an RSC (component) route throws a clear
directive error.

So `dispatch` IS the way to exercise a RESPONSE route's real route-level
middleware chain (the guard stack) against the actual registered tree. The gap:
a COMPONENT route's guard stack cannot run here (dispatch refuses it, and
`renderToFlightString`/`renderRoute` don't run route middleware) — assert that at
e2e, or extract the middleware fn and unit-test it with `runMiddleware`.

SETUP CAVEAT (use the preset): `@rangojs/router` resolves to server-only STUBS
outside the `react-server` condition (urls/createRouter/cookies/getRequestContext
throw), and importing your router also pulls `@vitejs/plugin-rsc/rsc` (whose body
imports Vite virtuals). Vitest does not apply the `react-server` condition to
bare-package resolution. The preset `@rangojs/router/testing/vitest` handles all
of it — alias `@rangojs/router` to real impls + stub the virtuals — so no
per-file `vi.mock` is needed. Spread `rangoTestConfig(...)` into your `test`
block:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { rangoTestConfig } from "@rangojs/router/testing/vitest";
export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    ...rangoTestConfig({ preset: "cloudflare" }),
  },
});
```

`rangoTestConfig` returns BOTH the resolve `alias` entries AND
`server.deps.inline: [/@rangojs[/\\]router/]`. The `deps.inline` half is
mandatory for an installed (node_modules) consumer: `@rangojs/router` ships as
TypeScript source, Vitest externalizes node_modules by default, and Node >= 23
refuses to type-strip `.ts` under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — `deps.inline` forces Vite (not
Node) to transpile rango's source. The preset entry itself ships as compiled JS,
so the `import { rangoTestConfig }` line loads under plain Node config loading.
(If you need only the aliases, `rangoTestAliases(...)` is still exported, but then
you must wire `server.deps.inline` yourself.)

LIMITATION: the FULL router usually can't be imported in a bare test —
`Prerender()`/`createLoader()` need the plugin-injected `$$id` (real `Prerender()`
throws "missing $$id"). Build a router from a `Prerender`-free include (your API
routes); `dispatch` accepts the public router type with no cast:

```ts
import { describe, it, expect } from "vitest";
import { dispatch } from "@rangojs/router/testing";
import { createRouter } from "@rangojs/router";
import { apiPatterns } from "../src/api/urls"; // path.json(...) routes only

const router = createRouter().routes(apiPatterns);

it("serializes a JSON response route (auto-wrapped under data)", async () => {
  const res = await dispatch(router, "/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: { status: "ok" } });
});

it("maps a thrown RouterError to its status + typed JSON envelope", async () => {
  const res = await dispatch(router, "/products/999");
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe("NOT_FOUND");
});
```

### renderToFlightString — real async Server Component

A REAL Flight render of an async Server Component, in plain node — but ONLY
under the `react-server` condition (see the next section for the vitest
project). The render runs inside a request context, so async components can call
`getRequestContext()`, read params, cookies, etc.

```tsx
// flight.rsc-test.tsx  (note the *.rsc-test suffix)
import { describe, it, expect } from "vitest";
import { renderToFlightString } from "@rangojs/router/testing/flight";
// Matchers are a SEPARATE subpath (they import vitest); renderToFlightString does not.
import { flightMatchers } from "@rangojs/router/testing/flight-matchers";

expect.extend(flightMatchers);

// Keep components PURE leaves: take data as props. Do NOT import a server API
// (getRequestContext, cookies) from the `@rangojs/router` barrel — under the
// react-server condition the bare specifier resolves to the throwing stub, so
// it cannot be flight-tested in a bare consumer project.
async function Greeting({ name }: { name: string }) {
  await Promise.resolve();
  return <div>Hello {name}!</div>;
}
async function ItemView({ id }: { id: string }) {
  return <span>id={id}</span>;
}

it("renders text and props", async () => {
  expect(await renderToFlightString(<Greeting name="Ada" />)).toMatchFlight(
    "Ada",
  );
  expect(await renderToFlightString(<ItemView id="42" />)).toMatchFlight("42");
});

it("matches a normalized snapshot", async () => {
  expect(
    await renderToFlightString(<Greeting name="World" />),
  ).toMatchFlightSnapshot();
});
```

`toMatchFlight(substring)` asserts the normalized Flight string CONTAINS the
substring (containment, not equality — the row framing is an internal serializer
detail). `toMatchFlightSnapshot()` snapshots the normalized payload. SCOPE:
`renderToFlightString` returns the wire STRING; for typed assertions on a client
boundary's props, use `renderServerTree` (next).

### renderServerTree — serialize then deserialize to an inspectable tree

Same react-server project. Serializes the real Flight, then deserializes it to a
React element tree you can traverse. The win over the wire string: a client
boundary's props come back as REAL JS values (a `Date` is a `Date`), and you can
confirm a `"use client"` component crossed the boundary (an `I` row) vs being
inlined. No hydration / no interaction (that is the e2e tier).

Wire `rangoUseClientTransform()` into `vitest.rsc.config.ts`
(`plugins: [rangoUseClientTransform()]`, imported from `@rangojs/router/testing/vitest`)
so islands are auto-discovered from the server tree's own imports — pass nothing:

```tsx
import { it, expect } from "vitest";
import {
  renderServerTree,
  findClientBoundaries,
} from "@rangojs/router/testing/flight";
import { PriceTag } from "./PriceTag.js"; // a "use client" component (any filename)

async function Panel({ amount, asOf }: { amount: number; asOf: Date }) {
  await Promise.resolve();
  return <PriceTag amount={amount} currency="USD" asOf={asOf} />;
}

it("client props survive the round trip", async () => {
  const { flight, tree } = await renderServerTree(
    <Panel amount={19.5} asOf={new Date("2026-01-02T00:00:00Z")} />,
  );
  expect(flight).toMatchFlight("PriceTag"); // wire assertions still work
  const [tag] = findClientBoundaries(tree, "PriceTag");
  expect(tag.props.amount).toBe(19.5); // a real number
  expect(tag.props.asOf).toBeInstanceOf(Date); // a real Date, not "$D..."
});
```

`findClientBoundaries(tree, name?)` always returns an array (`{ id, name, props,
element }[]`) in document order, optionally filtered by export name; destructure
`const [tag] = …` for one island, assert `.length` when count matters (missing
name -> `[]`). Without the transform, register islands explicitly instead:
`renderServerTree(<Panel/>, { clientComponents: { PriceTag } })`. A true
interactive, clickable DOM `renderServer` is intentionally NOT shipped —
in-process happy-dom hydration re-tests React and misses server/client divergence
(which needs a real browser). Use e2e for interaction.

`renderServerTree` renders an ELEMENT you build (`<Page/>`); `vars` seeds
`ctx.get(MyVar)` for a server component reading `getRequestContext()` during
render. To test a route **handler** (a `(ctx) => rsc` function), use
`renderHandler` (below).

### renderHandler — run a real route handler (`(ctx) => rsc`)

A Rango route **handler** is a pure function `(ctx) => rsc` — what you pass to
`path("/p/:slug", ProductPage)`, NOT a component. `renderHandler` runs it with the
real `HandlerContext` (so `ctx.params`, `ctx.use(Loader)`, `ctx.use(Meta)`,
`ctx.reverse`, `ctx.get` work), then serializes its RSC -> inspectable tree.
Loaders are SEEDED (no real run), same as `runLoader`.

```tsx
import {
  renderHandler,
  findClientBoundaries,
} from "@rangojs/router/testing/flight";

const { tree, handles, thrown, cookies, headers, locationState } =
  await renderHandler(ProductPage, {
    // ProductPage: (ctx) => rsc, as authored
    params: { slug: "wine" },
    loaders: [[ProductLoader, { name: "Wine" }]], // seeds ctx.use(ProductLoader)
    vars: [[Tenant, { name: "Acme" }]], // seeds ctx.get(Tenant)
    routeMap: { product: "/p/:slug" }, // enables ctx.reverse
  });
expect(JSON.stringify(tree)).toContain("Wine");
expect(handles.get(Meta)).toEqual([{ title: "Wine - Shop" }]); // ctx.use(Meta) pushes
```

Result: `{ tree, flight, thrown, response, cookies, headers, locationState, handles }`.
The render counterpart to `runInRequestContext`: it surfaces the same effects AND
the rendered RSC. A `throw redirect()` is captured on `thrown` (tree undefined,
since it produced a Response). An unseeded `ctx.use(loader)` rejects. Use
`renderServerTree` for a plain ELEMENT; `renderHandler` for a handler FUNCTION.

## E2E recipes (Playwright)

Wire the harness once, passing your own Playwright `test`/`expect` (so
`@rangojs/router/testing/e2e` never imports `@playwright/test` at runtime — it is
an optional peer you install). Import the harness from the **`/e2e` entry** — the
unit barrel is not loadable in a plain Playwright runner:

```ts
// e2e/helper.ts
import { test, expect } from "@playwright/test";
import { createRangoE2E } from "@rangojs/router/testing/e2e";

export const e2e = createRangoE2E({
  test,
  expect,
  defaultRoot: new URL("..", import.meta.url).pathname, // your app root
});
export const { useFixture, parityDescribe, expectParity, rangoMatchers } = e2e;
```

### parityDescribe REPLACES hand-titling `(production)`

This is THE mechanism that satisfies the dev+prod mandate structurally. One
declaration registers a dev describe (`name`) AND a production describe
(`` `${name} (production)` ``) from one body — the `(production)` suffix is
generated, so the prod suite can never drift into the dev bucket. Use `f.url(...)`
for navigation.

```ts
import { test, expect } from "@playwright/test";
import { parityDescribe, rangoMatchers } from "./helper";
// rangoMatchers ships the type augmentation, so `expect(page).toHaveRangoPathname`
// is typed after extend.
expect.extend(rangoMatchers);

parityDescribe("product navigation", (f) => {
  test("navigates to a product and updates the pathname", async ({ page }) => {
    await page.goto(f.url("/"));
    await page.getByTestId("product-link").click();
    await expect(page).toHaveRangoPathname("/products/1");
  });
});
```

The body runs verbatim against a dev server (`pnpm dev`) and a built+previewed
server (`pnpm build` + `pnpm preview`). `useFixture` handles spawn, dep-optimizer
warmup, cross-platform process-group kill, and teardown.

### expectParity — JS path vs no-JS progressive enhancement

Runs one intent over the JS path and a fresh no-JS context, asserting the
observed testids, pathname, and cookies match. CONTRACT: PE parity only holds if
the submit target is a real `<form>` (no-JS does a native POST). Cookie
observation is `document.cookie` (non-HttpOnly only) in v1.

```ts
parityDescribe("add to cart parity", (f) => {
  test("JS and no-JS produce the same result", async ({ page }) => {
    await page.goto(f.url("/products/1"));
    await expectParity(
      page,
      { submit: { testId: "add-to-cart-form", data: { qty: "2" } } },
      { observe: ["cart-count", "flash"] },
    );
  });
});
```

`intent` is `{ navigate: string }` or `{ submit: { testId, data? } }`. Other
helpers from `createRangoE2E`: `waitForHydration`, `expectNoReload`,
`expectNoPageError`, `testId`, `waitForNavigation`, `goBack`/`goForward`,
`testNoJs` (a `test` with JS disabled). `rangoMatchers` ships
`toHaveRangoPathname` only — `toHaveSegments`/`toHaveParams` are a documented
future addition (they need a client-emitted signal that does not exist yet; do
not assume them).

## Cache / SWR / prerender recipes

The `X-Rango-Cache` header is emitted **only** when the gate is on:
`createRouter({ debugCacheSignal: true })` or `process.env.RANGO_TEST_SIGNALS === "1"`.
Off by default — zero production surface. v1 status is COARSE (route-level, keyed
by the route key — the route NAME, e.g. `product.detail`, NOT the URL pattern),
not per-individual-segment. `assertCacheStatus` reads that header.

```ts
// In a Playwright e2e, import cache-status helpers from the e2e entry (the
// `@rangojs/router/testing` barrel is Vitest-only — it pulls a build virtual).
import { assertCacheStatus } from "@rangojs/router/testing/e2e";

// e2e (the gate must be enabled on the app under test). The segment key is the
// route NAME the header carries, not the URL pattern ("/products/:id").
const res = await page.request.get(f.url("/products/1"));
assertCacheStatus(res, "product.detail", "miss");
const res2 = await page.request.get(f.url("/products/1"));
assertCacheStatus(res2, "product.detail", "hit");
```

Statuses: `"hit" | "miss" | "stale" | "prerendered" | "passthrough"`.

Zero-prod-surface alternative — the telemetry sink (no header at all):

```ts
import { createCacheSink, filterCacheDecisions } from "@rangojs/router/testing";
const { sink, events } = createCacheSink();
const router = createRouter({ telemetry: sink /* ... */ }).routes(urlpatterns);
// ...drive a request...
const decisions = filterCacheDecisions(events);
expect(decisions[0].segments?.[0].cacheStatus).toBe("hit");
```

PRERENDER: a pre-rendered route is **indistinguishable from a cache hit by
design** — the worker handles every request and looks up a stored Flight payload
(see `/prerender`). The browser cannot tell. So you cannot assert "prerendered"
from the rendered DOM; assert it via the signal (`assertCacheStatus(res, seg,
"prerendered")`), and run prerender assertions in **production** mode (build-time
artifacts only exist after `pnpm build`).

## Anti-patterns and gotchas

- **No dev-only e2e.** A `useFixture({ mode: "build" })` describe whose title
  omits `(production)` silently lands in the dev bucket — prod coverage lost,
  no error. Always use `parityDescribe`; never hand-title. `(prod)`,
  `-build`, `-prod` do NOT count — the bucketing matches the literal
  `(production)`.
- **Don't hand-mock the router provider** to test a client component — use
  `renderRoute`, which mounts the real `NavigationProvider`.
- **Don't call `createLoader(...)` in a unit test** and try to invoke it.
  Extract the body and pass it to `runLoader`.
- **`dispatch` needs the plugin-rsc mock** (or a Vite-RSC env). A bare import of
  your router throws on Vite virtual modules otherwise.
- **`renderToFlightString` is not a node test.** It only runs under the
  react-server vitest project; name files `*.rsc-test.{ts,tsx}` and run
  `pnpm test:unit:rsc`. The main vitest project must NOT set the react-server
  condition (it would flip React to the no-hooks server build and break every
  `renderRoute`/client test).
- **Running an e2e subset:** add `--no-deps` — `--grep` does NOT filter
  dependency projects, so grepping one production test otherwise pulls in the
  whole dev suite. And `--grep` is a regex: a pasted title containing
  `(production)` / `:locale?` / `[...]` mis-matches; grep a metacharacter-free
  fragment.

## Pre-push checklist (mirror CLAUDE.md)

Before pushing, run all of these and fix any failure:

1. `pnpm run typecheck` (or `pnpm exec tsc --noEmit`)
2. `pnpm run test:unit` (node + DOM vitest)
3. `pnpm run test:unit:rsc` (the react-server Flight project)
4. `pnpm run lint`
5. `pnpm run format`

And: **every e2e has a production counterpart.** `parityDescribe` makes this
automatic — if you wrote a plain `test.describe` for a behavior, convert it.
