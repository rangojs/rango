---
name: testing
description: Test @rangojs/router apps — unit (loaders/middleware/reverse/components), integration (dispatch/Flight), and e2e (dev+prod parity, progressive enhancement)
argument-hint: [layer]
---

# Testing @rangojs/router apps

Rango ships four consumer-facing testing entries, one per test runtime/dependency:
`@rangojs/router/testing` (unit + integration, under a Vite-driven Vitest
project), `@rangojs/router/testing/dom` (`renderRoute`, needs RTL + a DOM env),
`@rangojs/router/testing/e2e` (the Playwright harness), and
`@rangojs/router/testing/flight` (real Flight, react-server condition only).
The hard problem in an RSC app is that the layer you reach for is dictated by
**what the behavior touches** — a pure predicate is a one-line vitest test; a
real async Server Component cannot be a plain node test at all. Pick the layer
**first**, then the primitive. Reaching one layer too high (e2e for a reverse
function) is slow; one too low (a node test for Flight) fails to compile or
silently asserts nothing.

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
| one loader's data logic                                                                                   | unit (node)  | `runLoader` (pass the **raw fn**, not `createLoader`)            | `@rangojs/router/testing`        |
| one middleware's ordering / short-circuit / cookie+header merge                                           | unit (node)  | `runMiddleware`                                                  | `@rangojs/router/testing`        |
| a CLIENT component reading router context (`useParams`/`useReverse`/`Outlet`/`useNavigation`/`useLoader`) | unit (DOM)   | `renderRoute` (needs happy-dom/jsdom + `@testing-library/react`) | `@rangojs/router/testing/dom`    |
| a redirect / status / headers / cookies / **response route** (json/text/html/xml/md), no Flight           | integration  | `dispatch` (router -> Response)                                  | `@rangojs/router/testing`        |
| a real async **Server Component** / Flight serialization shape                                            | RSC unit     | `renderToFlightString` + `toMatchFlight`                         | `@rangojs/router/testing/flight` |
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
`nextCalled` is `0` on short-circuit, `1` on pass-through. The returned `ctx` is
the underlying `RequestContext` — read `ctx.cookies()`, `ctx.get(...)`,
`ctx.res.headers`.

```ts
import { describe, it, expect } from "vitest";
import { runMiddleware } from "@rangojs/router/testing";
import type { MiddlewareFn } from "@rangojs/router";

const requireUser: MiddlewareFn = async (ctx, next) => {
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
several in order. Cookies set via `cookies().set(...)` surface both on
`ctx.cookies()` and on the merged response `Set-Cookie`.

### runLoader — one loader's data logic

Pass the **RAW loader function** `(ctx) => ...`, NOT a `createLoader(...)`
handle. `createLoader` relies on the Vite `$$id` injection for RSC
registration, which does not exist in a bare vitest process — calling it gives
you a handle with no `fn` to run. `runLoader` invokes your function directly
against a real `RequestContext`, so cookies, headers, `ctx.get`, and
`ctx.reverse` resolve.

```ts
import { runLoader } from "@rangojs/router/testing";
import { createVar } from "@rangojs/router";

// CORRECT: test the function body directly.
async function productLoaderBody(ctx) {
  return { id: ctx.params.id, region: ctx.env.REGION, user: ctx.get(User) };
}

it("reads params, env, and seeded vars", async () => {
  const User = createVar<{ name: string }>();
  const data = await runLoader(productLoaderBody, {
    params: { id: "42" },
    env: { REGION: "eu" },
    vars: [[User, { name: "Ada" }]],
  });
  expect(data).toEqual({ id: "42", region: "eu", user: { name: "Ada" } });
});
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

If your real loader source is `export const L = createLoader(async (ctx) => {...})`,
extract the inner async function so it is importable on its own, and register
the `createLoader` wrapper in `urls()`. Then `runLoader` tests the body and the
DSL/e2e tests cover registration.

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

FIDELITY CAVEAT — this is the **client tree only**. It does NOT catch
server/client boundary reference-identity remount bugs, real Flight
serialization errors, loader execution, middleware, or handler ordering. Those
are `renderToFlightString` / e2e territory. Loader data is seeded, never run.
Needs a DOM env (`// @vitest-environment happy-dom`, or jsdom) and the consumer
must install `@testing-library/react` (optional peer).

### Type-level test: a reverse misuse should fail to compile

`reverse`/`href` are compile-time checked (`/typesafety`). Pin that contract
with `@ts-expect-error` — a _runtime_ test cannot.

```ts
import { useReverse } from "@rangojs/router/client";
const reverse = useReverse({ product: "/products/:productId" });
reverse("product", { productId: "2" }); // ok
// @ts-expect-error missing required param
reverse("product", {});
// @ts-expect-error unknown route name
reverse("nope", {});
```

## Integration recipes

### dispatch — request -> Response, without Flight

In-process matching + middleware, no RSC render. Covers `308` redirects
(trailing slash etc.) with `Location`, `404`, response routes
(json/text/html/xml/md with content negotiation), and **global + route-level
middleware** short-circuits with full `next()`/throw/header+cookie fidelity. It
reuses the router's own `previewMatch`, so middleware collection is the router's,
not a re-implementation. Hitting an RSC (component) route throws a clear
directive error.

SETUP CAVEAT (use the preset): `@rangojs/router` resolves to server-only STUBS
outside the `react-server` condition (urls/createRouter/cookies/getRequestContext
throw), and importing your router also pulls `@vitejs/plugin-rsc/rsc` (whose body
imports Vite virtuals). Vitest does not apply the `react-server` condition to
bare-package resolution. The preset `@rangojs/router/testing/vitest` handles all
of it — alias `@rangojs/router` to real impls + stub the virtuals — so no
per-file `vi.mock` is needed:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { rangoTestAliases } from "@rangojs/router/testing/vitest";
export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
  resolve: { alias: rangoTestAliases({ cloudflare: true }) },
});
```

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
server-only / leaf trees — a client component emits an unresolved `I[...]` import
row against the empty client manifest (fine for snapshotting shape, not
hydratable). A true interactive, clickable DOM `renderServer` is a DEFERRED
follow-up: the react-server-vs-default condition wall requires a two-environment
setup. For interactive server-component behavior today, use e2e.

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
by route key), not per-individual-segment. `assertCacheStatus` reads that header.

```ts
import { assertCacheStatus } from "@rangojs/router/testing";

// e2e (the gate must be enabled on the app under test)
const res = await page.request.get(f.url("/products/1"));
assertCacheStatus(res, "/products/:id", "miss");
const res2 = await page.request.get(f.url("/products/1"));
assertCacheStatus(res2, "/products/:id", "hit");
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
