# Testing @rangojs/router apps

This is the prose guide. For the dense, decision-tree-first version, see the
[`/testing` skill](../skills/testing/SKILL.md). Both describe the same public
surface, split into four entries by test runtime/dependency:
`@rangojs/router/testing` (unit + integration, under a Vite-driven Vitest
project), `@rangojs/router/testing/dom` (`renderRoute`, needs RTL + a DOM env),
`@rangojs/router/testing/e2e` (the Playwright harness), and
`@rangojs/router/testing/flight` (real Flight, react-server condition only).

## Philosophy: the RSC-first testing pyramid

An RSC router has more layers than a classic SPA, and the cost of testing a
behavior at the wrong layer is higher. The pyramid, bottom (fast, many) to top
(slow, few):

1. **Pure / context-isolated units** — `reverse`, a `revalidate` predicate, one
   loader's data logic, one middleware's branching. Milliseconds, node.
2. **Client-tree component units** — a component reading router context, in a
   DOM env, with seeded data. No server, no Flight.
3. **In-process integration** — a request to a `Response` (`dispatch`), or a
   real Flight render (`renderToFlightString`). No browser.
4. **End-to-end** — a real dev or production server, real navigation, real
   hydration, progressive enhancement. The only layer that proves the
   server/client boundary, real Flight serialization, and PE all at once.

The discipline: **the layer is chosen by what the behavior touches**, not by
preference. A reverse function is layer 1 even though it ships to the client. A
real async Server Component cannot be tested below layer 3 — there is no Flight
serializer available to a plain node test. The single rule that enforces this:

> If the behavior needs a real Flight render, it cannot be a plain vitest node
> test. It is `renderToFlightString` (layer 3, under the react-server project)
> or e2e (layer 4).

Two mandates ride on top of the pyramid (they are repo policy and apply to
consumer apps):

- **Every e2e covers BOTH dev and production.** A dev-only e2e is not
  acceptable.
- **Progressive-enhancement parity** is asserted explicitly: a form-driven flow
  must produce the same observable result with JS on and JS off.

Both are made structural by `parityDescribe` and `expectParity`, below.

## The testing surface, mapped to the API

| You ship / consume…                           | Test that…                                          | Layer               | Primitive                                      | Skill                                    |
| --------------------------------------------- | --------------------------------------------------- | ------------------- | ---------------------------------------------- | ---------------------------------------- |
| `reverse` / `useReverse` / `href`             | the URL is correct; misuse fails to compile         | unit + types        | call directly; `@ts-expect-error`              | `/typesafety`, `/links`                  |
| a `loader()` body                             | data logic given params/env/vars/search             | unit (node)         | `runLoader` (raw fn)                           | `/loader`                                |
| `middleware()` (auth, logging)                | ordering, short-circuit, cookie/header merge        | unit (node)         | `runMiddleware`                                | `/middleware`                            |
| a client component reading router context     | it renders given params/loaderData/Outlet           | unit (DOM)          | `renderRoute`                                  | `/hooks`                                 |
| a component reading `useLocationState`        | it renders the seeded location-state value          | unit (DOM)          | `renderRoute` (`locationState` option)         | `/location-state`                        |
| a component reading `useHandle` (Breadcrumbs) | it renders the seeded handle output                 | unit (DOM)          | `renderRoute` (`handles` option)               | `/handles`                               |
| a handle's `collect`/accumulator              | it maps per-segment pushes to the accumulated value | unit (node)         | `collectHandle`                                | `/handles`                               |
| a response route (`path.json/.text/...`)      | status, content-type, body, content negotiation     | integration         | `dispatch`                                     | `/response-routes`, `/mime-routes`       |
| a redirect / `404` / middleware redirect      | the `Response` (status + `Location`)                | integration         | `dispatch`                                     | `/middleware`, `/route`                  |
| an async Server Component                     | real Flight output / serialization shape            | RSC unit            | `renderToFlightString` + `toMatchFlight`       | `/route`                                 |
| a `"use server"` action + revalidation flow   | the mutate -> reload -> UI update, JS and no-JS     | e2e                 | `parityDescribe` + `expectParity`              | `/server-actions`                        |
| navigation / hydration / view transitions     | no reload, no page error, correct pathname          | e2e                 | `parityDescribe`, `waitForHydration`, matchers | `/hooks`, `/view-transitions`            |
| `cache()` / `"use cache"` / loader cache      | hit/miss/stale across two requests                  | e2e + signal        | `assertCacheStatus` / telemetry sink           | `/caching`, `/use-cache`, `/cache-guide` |
| `Prerender(...)` routes                       | served from a build-time artifact (a cache hit)     | e2e (prod) + signal | `assertCacheStatus(..., "prerendered")`        | `/prerender`                             |
| the generated `*.named-routes.gen.ts`         | it matches the runtime route map (drift in CI)      | unit (node)         | `assertGeneratedRoutesMatch`                   | `/typesafety`                            |

## What these primitives deliberately don't cover

The unit/integration primitives test the **pieces** (a loader body, a middleware
fn, a seeded component read, a collect fn). They do NOT run the real server, real
Flight round-trip, or the client navigation lifecycle. Several behaviors look
unit-testable but are not — a test can mount/run and go green while proving
nothing. Know these traps, and the seeds that close the easy ones:

| Looks testable, but…                                                                                                                        | Reality                                                                                                                                   | What to do                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `useNavigation()` / `useLinkStatus()` / `useAction()` **non-idle** states (loading/streaming/pending, action result/error) in `renderRoute` | `renderRoute.navigate()` bypasses the navigation lifecycle, so the controller never leaves `idle` — you can only assert the idle snapshot | Test the pending/streaming UI at **e2e**                                                            |
| `ctx.search` (typed search schema) in a loader                                                                                              | Defaults to `{}`; `opts.search` only sets the raw `ctx.searchParams`                                                                      | Seed the typed object with **`searchData`** on `runLoader`                                          |
| `ctx.theme` / `ctx.setTheme` in a handler                                                                                                   | Always `undefined` — the real handler injects the theme config                                                                            | Pass **`theme`** (the `createRouter({ theme })` shape) to `runLoader`/`runMiddleware`/`renderRoute` |
| `redirect()` basename prefixing                                                                                                             | Defaults to no prefix                                                                                                                     | Seed **`basename`** on `runLoader`/`runMiddleware`; `dispatch` uses the router's own basename       |
| `useReverse`/`useHref` under an `include('/shop', …)` mount in `renderRoute`                                                                | `renderRoute` does not model include mounts — reverse/href come back **un-prefixed**                                                      | Assert mount-prefixed URLs at **e2e**, or pass the fully-mounted pattern to `useReverse` directly   |
| `dispatch(router, req)` as a full request→response                                                                                          | Throws on RSC/component routes; rejects action/partial requests; only response routes + redirects + 404 + content negotiation             | Use `renderToFlightString` (Flight) or e2e for anything that renders                                |
| `renderToFlightString` of a realistic page                                                                                                  | Pure **leaf / server-only** — a client island emits an un-hydratable `I[...]` row                                                         | Keep Flight tests to leaf server components; test full pages at e2e                                 |

The **real wiring** is e2e by construction and intentionally out of scope here:
server actions + revalidation, `cache()` hit/miss/stale over real requests,
prerender serving, progressive-enhancement parity, the Flight serialize→hydrate
round-trip, and server→client reference identity (the remount-bug class — a
client reference must resolve to the same client reference, which only a real
hydrated render exercises). For those, reach for `createRangoE2E` /
`parityDescribe` / `assertCacheStatus`.

## Setup

### Dependencies

Install vitest plus the optional peers for the layers you use:

```bash
pnpm add -D vitest @testing-library/react @testing-library/dom happy-dom @playwright/test
```

- `vitest` — the unit/integration/RSC test runner. The router internals import
  the `@rangojs/router:version` virtual module, so a plain-node Vitest cannot
  load them as-is; use the **`rangoTestAliases()` preset** (next section) to
  resolve them — you do NOT need to wire the full rango Vite plugin into the test
  config.
- `@testing-library/react` (and its `@testing-library/dom` peer) + a DOM env
  (`happy-dom` or `jsdom`) — required for
  `renderRoute`, which lives at its own entry `@rangojs/router/testing/dom` and
  lazy-loads RTL at call time. Both are optional peers; the `@rangojs/router/testing`
  barrel never references them, so a unit suite testing only loaders/middleware/`dispatch`
  needs neither RTL nor a DOM env.
- `@playwright/test` — required for e2e. It is an optional peer: the e2e harness
  lives at `@rangojs/router/testing/e2e` (a separate entry, loadable in a plain
  Playwright runner) and never imports `@playwright/test` at runtime — you pass
  your own `test`/`expect` into `createRangoE2E`.

### Resolving `@rangojs/router` in a unit test — use the preset

Importing your own app's router / loaders / middleware in a bare Vitest process
does **not** work out of the box, and the failure is non-obvious:

- `@rangojs/router` resolves to **server-only stubs** outside the `react-server`
  condition — `urls()`, `createRouter()`, `cookies()`, `getRequestContext()`
  _throw_ ("only available … in a react-server/RSC environment"). So importing
  your router fails immediately.
- Vitest does **not** apply the `react-server` condition to bare-package exports
  resolution, and enabling it globally flips React to its server build (no
  `createContext`), which crashes the router's client-boundary imports.

The fix is to alias **only** the bare `@rangojs/router` specifier to its
react-server entry (real impls) while leaving React as the client build. Rather
than hand-assemble that, use the shipped preset:

```ts
// vitest.config.ts  (the node + DOM project)
import { defineConfig } from "vitest/config";
import { rangoTestAliases } from "@rangojs/router/testing/vitest";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.{test,spec}.{ts,tsx}"],
    environment: "node", // renderRoute tests use a `// @vitest-environment happy-dom` pragma
  },
  resolve: {
    // `cloudflare: true` also stubs the cloudflare:workers / cloudflare:email
    // runtime virtuals a Cloudflare app's route tree imports.
    alias: rangoTestAliases({ cloudflare: true }),
  },
});
```

`rangoTestAliases()` aliases the bare `@rangojs/router` to its real impls and
stubs the build-only `@rangojs/router:version` and `@vitejs/plugin-rsc/rsc`
virtuals — so you do **not** need a per-file `vi.mock("@vitejs/plugin-rsc/rsc")`.

> **Limitation:** even with the preset, the **full** app router cannot be
> imported if it uses `Prerender()` / `createLoader()` — their build-time
> `$$id` is injected by the rango Vite plugin and is absent in a bare test, so
> the real `Prerender()` throws "missing $$id". For `dispatch`, build a router
> from an importable, `Prerender`-free include (e.g. your API routes); assert
> whole-router behavior with e2e.

### Two vitest projects

You need two, because real Flight rendering requires the `react-server` node
condition, and that condition flips React to its server (no client hooks) build —
which would break every client/`renderRoute` test. The Flight project does **not**
use the preset (its `@rangojs/router` alias would crash under the server React
build); Flight tests cover pure leaf server components.

`vitest.config.ts` (the default node + DOM project) — uses the preset, above.

`vitest.rsc.config.ts` (the Flight project):

```ts
import { defineConfig } from "vitest/config";

// Force production React in this process and any forked worker (forks inherit
// process.env). Dev NODE_ENV crashes the bare worker (jsxDEV owner-stack
// machinery is uninitialized) and also emits volatile debug rows in the Flight
// payload, defeating stable snapshots.
process.env.NODE_ENV = "production";

export default defineConfig({
  resolve: { conditions: ["react-server"] },
  test: {
    globals: true,
    include: ["**/*.rsc-test.{ts,tsx}"],
    pool: "forks",
    // Vitest 4: top-level pool option. Force the condition on the forked
    // worker, or React throws "the react-server condition must be enabled".
    execArgv: ["--conditions=react-server"],
  },
});
```

Scripts:

```jsonc
{
  "scripts": {
    "test:unit": "vitest run",
    "test:unit:rsc": "vitest run --config vitest.rsc.config.ts",
  },
}
```

Why separate, restated because it is the most common setup mistake: the
vendored react-server-dom serializer can only be imported under
`--conditions=react-server`; the default React build _throws_ under that
condition; and enabling the condition globally would break every normal client
test (~all `renderRoute` tests and any test that mocks
`@vitejs/plugin-rsc/rsc`). One project per condition.

### Pointing the e2e fixture at your app

`useFixture`/`parityDescribe` spawn a server from your app root. Pass it once as
`defaultRoot` in `createRangoE2E`, or per-call as `options.root`:

```ts
// e2e/helper.ts
import { test, expect } from "@playwright/test";
import { createRangoE2E } from "@rangojs/router/testing/e2e";

export const e2e = createRangoE2E({
  test,
  expect,
  defaultRoot: new URL("..", import.meta.url).pathname,
});
export const { useFixture, parityDescribe, expectParity, rangoMatchers } = e2e;
```

## Unit testing

### Loaders — pass the raw function, not `createLoader`

`runLoader` runs a loader's body against a real `RequestContext` (cookies,
headers, `ctx.get`, `ctx.reverse` all resolve) in plain node.

The `$$id` caveat, in depth: `createLoader(fn)` returns a handle whose job is
RSC registration. The Vite plugin injects a `$$id` (`path#export`) into that
handle at transform time so the loader can be serialized to the client and
matched on the server. In a bare vitest process there is no Vite transform, so a
`createLoader(...)` value has no usable `fn` to invoke and no real `$$id`. That
is by design — `runLoader` deliberately takes the **raw** async body so no build
step is required:

```ts
import { runLoader } from "@rangojs/router/testing";
import { createVar } from "@rangojs/router";

// Source: export the body separately so it is importable on its own.
// loaders/product.ts
export async function productLoaderBody(ctx) {
  const product = await ctx.env.DB.get(ctx.params.id);
  if (!product) return { product: null };
  return { product, self: ctx.reverse("product", { id: ctx.params.id }) };
}
// export const ProductLoader = createLoader(productLoaderBody); // registered in urls()

// product.test.ts
it("returns the product and a self link", async () => {
  const data = await runLoader(productLoaderBody, {
    params: { id: "42" },
    env: { DB: { get: async () => ({ name: "Widget" }) } },
    routeMap: { product: "/products/:id" }, // required for ctx.reverse
  });
  expect(data.product.name).toBe("Widget");
  expect(data.self).toBe("/products/42");
});
```

Options: `params` (also surfaced as `routeParams`), `search`, `env`, `vars`
(an object `{ key: value }`, or `[key, value]` tuples where the key may be a
`createVar()` handle), `method`/`body`/`formData`, `routeMap`/`routeName`, and
`use` (resolver for `ctx.use(OtherLoader)`). Without `use`, `ctx.use` runs a
dependency's own `fn` if it carries one. In the body, `ctx.reverse` accepts any
name from `routeMap` and `ctx.get` accepts any string key or `createVar()` handle
(both are driven by the options, so neither is bound to the app's global
augmentation).

Unit-only limitations:

- `ctx.reverse(...)` throws without `routeMap`.
- `ctx.isAction(...)` (action-render context) is unavailable — cover with e2e.
- `ctx.rendered()` throws **by default** (the real render barrier only exists
  during a full match). For a loader that awaits the barrier then reads handle
  data — `await ctx.rendered(); ctx.use(SomeHandle)` (the "rendered barrier"
  pattern) — pass `{ rendered: true }` to mock the barrier and `{ handles:
[[SomeHandle, accumulatedData]] }` to seed the handle read:

  ```ts
  const data = await runLoader(livePricesBody, {
    rendered: true,
    handles: [[RenderedProducts, ["widget-a", "widget-b"]]],
  });
  ```

  This unit-tests the loader's POST-barrier compute logic against the seeded
  handle data. It does NOT exercise the real push -> accumulate -> barrier wiring
  (handlers actually pushing the data, the barrier's timing) — keep that in e2e.

### Middleware

`runMiddleware` executes the chain through the router's real `executeMiddleware`,
so behavior is production-identical: `next()`, return-Response and throw-Response
short-circuits, double-next guards, header/cookie merge.

```ts
import { runMiddleware } from "@rangojs/router/testing";
import { cookies } from "@rangojs/router";

it("sets a session cookie and passes through", async () => {
  const setSession = async (_ctx, next) => {
    cookies().set("session", "abc", { path: "/" });
    return next();
  };
  const { response, ctx, nextCalled } = await runMiddleware(setSession, "/");
  expect(nextCalled).toBe(1); // passed through
  expect(ctx.cookies().session).toBe("abc"); // observable on ctx
  expect(
    response.headers.getSetCookie().some((c) => c.startsWith("session=abc")),
  ).toBe(true);
});
```

`nextCalled` is `0` on short-circuit, `1` on pass-through. The returned `ctx` is
the underlying `RequestContext`. Seed prior state with `vars`, model the
downstream route with `next`, enable `ctx.reverse` with `routeMap`/`routeName`,
pass an array to run several in order.

### Reverse and components

`reverse`/`href` are compile-time checked — pin misuse with `@ts-expect-error`
(a runtime test cannot). For a client component reading router context, use
`renderRoute`:

```tsx
// @vitest-environment happy-dom
import { it, expect, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { useParams, useNavigation, usePathname } from "@rangojs/router/client";

afterEach(cleanup);

it("exposes navigation state and re-resolves on navigate()", async () => {
  function Page() {
    const { id } = useParams<{ id: string }>();
    return (
      <div>
        <span data-testid="id">{id}</span>
        <span data-testid="state">{useNavigation().state}</span>
        <span data-testid="path">{usePathname()}</span>
      </div>
    );
  }
  const { getByTestId, router } = await renderRoute(
    [{ path: "/users/:id", Component: Page }],
    { initialUrl: "/users/alice" },
  );
  expect(getByTestId("id").textContent).toBe("alice");
  expect(getByTestId("state").textContent).toBe("idle");
  await router.navigate("/users/bob");
  expect(router.params()).toEqual({ id: "bob" });
});
```

`RenderRouteSpec = { path, Component, layout?, loaderIds?, name? }`; the array is
the layout chain root-to-leaf, last entry is the leaf. Seed `useLoader` reads via
`options.loaderData` keyed by `$$id`; route them to a layout with that spec's
`loaderIds`.

Testing a component that reads `useLoader`: seed the loader BY REFERENCE via the
`loaders` option, not `loaderData`. A real `createLoader(fn)` handle has
`$$id === ""` in a bare test (the id is plugin-injected at build time), so keying
`loaderData` by `$$id` would collide under `""`; passing `[loader, data]` pairs
lets renderRoute assign a synthetic stable id and wire `useLoader` to it:

```tsx
const { getByTitle } = await renderRoute(
  [{ path: "/cart", Component: CartBadge }],
  { loaders: [[CartLoader, { itemCount: 3, total: 89.97 }]] },
);
```

Seed `useLocationState(def)` reads with the `locationState` option (`[def, value]`
pairs), and `useHandle(handle)` reads (e.g. a client Breadcrumbs trail) with the
`handles` option (`[handle, pushedValues[]]` pairs) — both seed by reference for
the same plugin-injected-id reason. A component reading only `useParams` /
`useReverse` / `useNavigation` needs no seeding.

### Testing a handle's `collect`/accumulator

A handle's collect function (the `createHandle(collect)` argument that maps the
per-segment pushed values into the accumulated result) is unit-testable directly
with `collectHandle(handle, segments)` — it runs your handle's REAL registered
collect on the per-segment values you provide:

```ts
import { collectHandle } from "@rangojs/router/testing";

const PageTitle = createHandle<string, string>(
  (s) => s.flat().at(-1) ?? "Home",
);
expect(collectHandle(PageTitle, [["Home"], ["Products"], ["Shoes"]])).toBe(
  "Shoes",
);

const Breadcrumbs = createHandle<Item>(); // default flatten
expect(collectHandle(Breadcrumbs, [[home], [post]])).toEqual([home, post]);
```

This works because `createHandle()` registers its collect even in a bare test
(it assigns a runtime fallback id when the Vite plugin did not inject one). The
same applies to `renderRoute`'s `handles` seeding: a handle's **custom** collect
now runs end-to-end, so a `useHandle(handle)` component sees the real
accumulated value (not a default flatten). The collect is also just a function,
so you can always export and call it directly if you prefer.

Fidelity caveat: client tree only. It will NOT catch server/client boundary
remount bugs, real Flight serialization, loader execution, middleware, or handler
ordering — those need `renderToFlightString` or e2e. Loader data is seeded, never
run.

## Integration

### dispatch — request to Response, plus the vi.mock requirement

`dispatch` runs the router's real matching + middleware (reusing
`previewMatch`), with no RSC render. It covers redirects, 404s, response routes,
and global + route-level middleware short-circuits. An RSC (component) route
throws a clear directive error.

Setup: use the `rangoTestAliases()` preset (above) so `@rangojs/router` resolves
to real impls and the `@vitejs/plugin-rsc/rsc` virtual is stubbed — no per-file
`vi.mock` needed. `dispatch` accepts your public router type directly (no cast).

Because the full app router usually can't be imported in a bare test (the
`Prerender`/`createLoader` `$$id` limitation above), build a router from an
importable, `Prerender`-free include — typically your response/API routes:

```ts
import { describe, it, expect } from "vitest";
import { dispatch } from "@rangojs/router/testing";
import { createRouter } from "@rangojs/router";
import { apiPatterns } from "../src/api/urls"; // path.json(...) routes, no Prerender

const router = createRouter().routes(apiPatterns);

it("serializes a JSON response route, auto-wrapped under { data }", async () => {
  const res = await dispatch(router, "/health");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(
    "application/json;charset=utf-8",
  );
  expect(await res.json()).toEqual({ data: { status: "ok" } });
});

it("maps a thrown RouterError to its status + typed JSON envelope", async () => {
  const res = await dispatch(router, "/products/999"); // handler throws RouterError 404
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe("NOT_FOUND");
});

it("returns 404 for an unmatched path", async () => {
  expect((await dispatch(router, "/nope")).status).toBe(404);
});
```

`dispatch` also covers trailing-slash/redirect targets (`findMatch`) — a
redirected path returns a 308 with the `Location` (query preserved). JSON
response routes are auto-wrapped as `{ data: <value> }`. Cookies and
`ctx.header(...)` set inside a response-route handler surface on the returned
`Response`. Pass env via `{ env }`.

### renderToFlightString — real async Server Components

Under the react-server vitest project (`*.rsc-test.{ts,tsx}`, run via
`pnpm test:unit:rsc`):

The matchers live at the separate `@rangojs/router/testing/flight-matchers`
subpath (they import `vitest`); `renderToFlightString` itself does not pull in
Vitest. Keep the component a **pure leaf** — receive data as props, do NOT import
a server API from the `@rangojs/router` barrel (see the caveat below):

```tsx
import { it, expect } from "vitest";
import { renderToFlightString } from "@rangojs/router/testing/flight";
import { flightMatchers } from "@rangojs/router/testing/flight-matchers";
expect.extend(flightMatchers);

// Pure leaf server component: data comes in as props, not from getRequestContext.
async function Profile({ id }: { id: string }) {
  const user = await Promise.resolve({ name: `User ${id}` });
  return <h1>{user.name}</h1>;
}

it("renders an async server component to Flight", async () => {
  const flight = await renderToFlightString(<Profile id="7" />);
  expect(flight).toMatchFlight("User 7");
});
```

`toMatchFlight(substring)` is containment on the normalized string (row framing
is an internal detail). `toMatchFlightSnapshot()` snapshots the normalized
payload. `renderToFlightString` options (`url`, `headers`, `env`, `params`,
`routeName`) set up the request context for a component that genuinely needs it
via internal imports — but a **consumer** importing those server APIs from the
barrel hits the caveat below, so prefer props.

Scope: server-only / leaf trees. A client component in the tree emits an
unresolved `I[...]` import row against the empty client manifest — fine for
snapshotting the payload shape, not hydratable. A fully interactive, clickable
DOM `renderServer` (hydrated) is a deferred follow-up: the react-server vs
default condition wall needs a two-environment setup, which v1 does not ship. For
interactive server-component behavior today, use e2e.

Consumer caveat: a server component that imports a server API from the
`@rangojs/router` **barrel** (e.g. `getRequestContext`, `cookies`) cannot be
flight-tested in a bare consumer project — under the Flight project's
`react-server` condition the bare specifier still resolves to the throwing
server-only stub, and the preset's alias (which fixes that for the node project)
crashes under the server React build on the router's `virtual:` imports. So keep
Flight tests to **pure leaf** server components (no `@rangojs/router` imports);
the example above reads params via the request context the test harness sets up,
which works because `renderToFlightString` enters `runWithRequestContext` for
you — but a component that itself calls `getRequestContext()` from the barrel is
outside v1 scope (cover it with e2e).

## E2E with dev/prod and PE parity

### parityDescribe — the default unit of organization

A build-fixture describe whose title omits `(production)` silently lands in the
**dev** bucket — production coverage is lost with no error. The repo enforces a
`(production)` title convention for exactly this reason. `parityDescribe` removes
the footgun: from one body it registers a dev describe (`name`) and a production
describe (`` `${name} (production)` ``), generating the suffix itself so the prod
suite cannot drift. **This is how you satisfy the dev+prod mandate
structurally** rather than by hand-titling.

```ts
import { test, expect } from "@playwright/test";
import { parityDescribe, rangoMatchers } from "./helper";
expect.extend(rangoMatchers);

parityDescribe("product navigation", (f) => {
  test("client-navigates without a reload", async ({ page }) => {
    await page.goto(f.url("/"));
    await page.getByTestId("product-link").click();
    await page.waitForURL("**/products/1");
    await expect(page).toHaveRangoPathname("/products/1"); // typed via the shipped augmentation
  });
});
```

`useFixture({ root, mode })` is the lower-level primitive `parityDescribe` builds
on; it spawns `pnpm dev` (dev) or `pnpm build` + `pnpm preview` (build), warms
the dep optimizer, and tears the server down with a cross-platform process-group
kill. Options include `command`, `buildCommand`, `isolatedServer`, `readyPath`,
`skipBuild`. Use `f.url(path)` to resolve against the running server.

### expectParity — JS vs no-JS

```ts
parityDescribe("add to cart parity", (f) => {
  test("JS and no-JS produce the same observable result", async ({ page }) => {
    await page.goto(f.url("/products/1"));
    await expectParity(
      page,
      { submit: { testId: "add-to-cart-form", data: { qty: "2" } } },
      { observe: ["cart-count", "flash-message"] },
    );
  });
});
```

It applies the intent (`{ navigate }` or `{ submit: { testId, data? } }`) over
the JS page and a fresh no-JS context, then asserts the observed testids' text,
the pathname, and `document.cookie` are equal. Contract: PE parity only holds if
the submit target is a real `<form>` (no-JS triggers a native POST). Cookie
observation sees non-HttpOnly cookies only in v1. If a page renders a
nondeterministic value, exclude that testid from `observe`.

Other harness helpers: `waitForHydration` (asserts the `data-hydrated` signal and
no hydration errors), `expectNoReload`, `expectNoPageError`, `testId`,
`waitForNavigation`, `goBack`/`goForward`, `testNoJs` (a `test` variant with JS
disabled), and `rangoMatchers.toHaveRangoPathname`.
(`toHaveSegments`/`toHaveParams` are a documented future addition — they need a
client-emitted signal that does not exist yet.)

### Running a subset locally

Two traps when grepping a single e2e:

1. **Project dependencies run unfiltered.** `--grep` does not filter dependency
   projects, so grepping one production test can pull in the whole dev suite. Add
   `--no-deps`.
2. **`--grep` is a regex.** A pasted title with `(`/`)`/`[`/`]`/`?` (the
   `(production)` tag itself, or `include("/oi/:locale?")`) mis-matches silently.
   Grep a metacharacter-free fragment, or escape.

```bash
pnpm exec playwright test --project=production --no-deps --grep "add to cart parity"
```

## Cache, SWR, and prerender

`X-Rango-Cache` is emitted **only** behind a debug gate — off by default, zero
production surface:

```ts
const router = createRouter({
  debugCacheSignal: true /* or env RANGO_TEST_SIGNALS=1 */,
});
```

Then assert across two requests (the gate must be on in the app under test):

```ts
import { assertCacheStatus } from "@rangojs/router/testing";

parityDescribe("product page caches", (f) => {
  test("second request is a hit", async ({ page }) => {
    assertCacheStatus(
      await page.request.get(f.url("/products/1")),
      "/products/:id",
      "miss",
    );
    assertCacheStatus(
      await page.request.get(f.url("/products/1")),
      "/products/:id",
      "hit",
    );
  });
});
```

Statuses: `hit | miss | stale | prerendered | passthrough`. v1 is COARSE
(route-level, keyed by route key), not per-individual-segment. `parseCacheHeader`
exposes the raw `{ segment: status }` map if you need it.

Zero-prod-surface alternative — the telemetry sink. No header at all; you inspect
captured `cache.decision` events:

```ts
import { createCacheSink, filterCacheDecisions } from "@rangojs/router/testing";
const { sink, events } = createCacheSink();
const router = createRouter({ telemetry: sink }).routes(urlpatterns);
// ...drive a request...
const decision = filterCacheDecisions(events)[0];
expect(decision.segments?.[0].cacheStatus).toBe("stale");
expect(decision.segments?.[0].shouldRevalidate).toBe(true);
```

Prerender: a pre-rendered route is **indistinguishable from a cache hit by
design** — the worker handles every request and looks up a stored Flight payload
(see `/prerender` and `docs/prerender-api-design.md`). There are no static
`.html`/`.rsc` files; the browser cannot tell. So do not try to assert
"prerendered" from the DOM — use the signal, and run prerender assertions in
**production** mode (the build-time artifacts only exist after `pnpm build`).

## Reference

All from `@rangojs/router/testing` unless noted — `renderRoute` is from
`@rangojs/router/testing/dom`, the e2e factory from `@rangojs/router/testing/e2e`,
the Flight helpers from `@rangojs/router/testing/flight`.

```ts
// Setup — @rangojs/router/testing/vitest (node/DOM project resolve.alias)
rangoTestAliases(opts?: { cloudflare?: boolean }): { find: string|RegExp; replacement: string }[];
// resolve: { alias: rangoTestAliases({ cloudflare: true }) }

// Unit
runMiddleware(
  mw: MiddlewareFn | MiddlewareFn[],
  request: Request | string,
  opts?: { env?, params?, vars?, routeMap?, routeName?, next?: () => Promise<Response> },
): Promise<{ response: Response; ctx: RequestContext; nextCalled: number }>;
// `ctx` is the RequestContext the chain ran under (read ctx.cookies(), ctx.get(...))
// const { response, nextCalled } = await runMiddleware(authMw, "/dashboard", { vars: { user: u } });

runLoader<T>(
  loaderFn: (ctx) => T | Promise<T>,   // RAW function, NOT createLoader(...)
  opts?: { params?, search?, env?, request?, vars?, routeMap?, routeName?, method?, body?,
           formData?, use?, rendered?, handles? },
): Promise<T>;
// vars accepts an object ({ user: u }) or [key, value] tuples ([[userVar, u]]).
// In the body, ctx.reverse accepts any routeMap name and ctx.get any string/ContextVar.
// rendered: true mocks ctx.rendered(); handles: [[H, accumulated]] seeds ctx.use(H).
// const data = await runLoader(loaderBody, { params: { id: "1" }, env });

// Component — @rangojs/router/testing/dom (DOM env + @testing-library/react)
renderRoute(                            // async; lazy-loads RTL at call time
  routes: RenderRouteSpec[],            // root->leaf; last = leaf route
  options?: {
    initialUrl?, params?, routeMap?,
    loaders?: [loader, data][],         // seed useLoader by REFERENCE (real handles)
    loaderData?: Record<$$id, data>,    // seed useLoader by explicit $$id
    locationState?: [def, value][],     // seed useLocationState by REFERENCE
    handles?: [handle, pushedValues[]][],// seed useHandle by REFERENCE
    handle?,                            // advanced: raw handle wire data
  },
): Promise<RenderResult & { router }>;
// const { getByTestId, router } = await renderRoute([{ path: "/p/:id", Component: P }], { initialUrl: "/p/1" });
// useLoader:        renderRoute([{ path: "/c", Component: CartBadge }], { loaders: [[CartLoader, cart]] });
// useLocationState: renderRoute([{ path: "/s", Component: FlashBanner }], { locationState: [[FlashMessage, { text: "Saved" }]] });
// useHandle:        renderRoute([{ path: "/p", Component: Trail }], { handles: [[Breadcrumbs, [{ label: "Home", href: "/" }]]] });

// Integration — @rangojs/router/testing
dispatch(router: Rango, request: Request | string, opts?: { env? }): Promise<Response>;
// accepts your public router type (no cast); use rangoTestAliases() for setup.
// const res = await dispatch(createRouter().routes(apiPatterns), "/health");

// RSC — @rangojs/router/testing/flight, react-server vitest project only
renderToFlightString(element, opts?: { url?, headers?, env?, params?, routeName? }): Promise<string>;
flightMatchers; // expect.extend -> toMatchFlight(substring), toMatchFlightSnapshot()
// expect.extend(flightMatchers); expect(await renderToFlightString(<C/>)).toMatchFlight("hi");

// Cache / prerender
assertCacheStatus(target: Response | { headers }, segment: string,
  expected: "hit"|"miss"|"stale"|"prerendered"|"passthrough"): void; // needs the debug gate on
parseCacheHeader(value): Record<string, string>;
createCacheSink(): { sink, events };   // wire via createRouter({ telemetry: sink })
filterCacheDecisions(events): CacheDecisionEvent[];

// Handle collect/accumulator
collectHandle(handle, segments: TData[][]): TAccumulated; // runs the handle's real collect
// expect(collectHandle(PageTitle, [["a"],["b"]])).toBe("b"); // a "last wins" collect

// Generated-route drift
diffGeneratedRoutes(router, generatedMap?): { missing, extra, mismatch, ok };
assertGeneratedRoutesMatch(router, generatedMap?): void;
// import NamedRoutes from "./router.named-routes.gen"; assertGeneratedRoutesMatch(router, NamedRoutes);
// include()-using apps: lazy include()d routes are absent from router.routeMap
// until first matched, so diffGeneratedRoutes force-expands them (via findMatch
// on each generated pattern) before diffing — the whole-app drift check works in
// a unit test. (Plain `{ routeMap }` objects without findMatch are diffed as-is.)

// Advanced context construction
createTestRequestContext(opts); toRequest(...); seedVariables(...);

// E2E factory (from @rangojs/router/testing/e2e; you pass Playwright test/expect)
createRangoE2E({ test, expect, defaultRoot? }): {
  useFixture, parityDescribe, expectParity, testNoJs, rangoMatchers,
  waitForHydration, expectNoReload, expectNoPageError, testId,
  waitForNavigation, goBack, goForward, /* ...timing/util helpers... */
};
useFixture({ root, mode?: "dev"|"build", command?, buildCommand?, isolatedServer?, readyPath?, skipBuild? })
  -> { mode, root, url(path?), proc() };
parityDescribe(name, (f) => { /* tests */ }, options?); // dev + (production) from one body
expectParity(page, { navigate } | { submit: { testId, data? } }, { observe: string[], baseURL? });
rangoMatchers; // expect.extend -> toHaveRangoPathname(page, expected)
```

## Migration: from an ad-hoc fixture to the official harness

If you copy-pasted a server-lifecycle fixture and hand-titled `(production)`
describes, migrate in two steps.

**1. Replace the fixture/helper with `createRangoE2E`.** Drop your bespoke
spawn/teardown code; it is exactly what `useFixture` does (with warmup and
cross-platform kill handled).

Before:

```ts
let serverProc, baseURL;
test.beforeAll(async () => {
  serverProc = spawn("pnpm", ["dev"]);
  baseURL = await waitForPort(serverProc);
});
test.afterAll(() => serverProc.kill());
test.describe("products", () => {
  /* dev tests using baseURL */
});
test.describe("products (production)", () => {
  /* duplicated body, build server */
});
```

After:

```ts
import { parityDescribe } from "./helper";
parityDescribe("products", (f) => {
  test("...", async ({ page }) => {
    await page.goto(f.url("/products")); /* ... */
  });
}); // one body; dev + (production) both registered, no duplication
```

**2. Replace ad-hoc `(production)` titling with `parityDescribe`.** Any place you
wrote two describes (one dev, one with a manually-appended `(production)`) is a
drift risk and duplication. Collapse to one `parityDescribe`. If a build-mode
describe was titled `(prod)` / `-build` / `-prod`, it was silently in the dev
bucket — `parityDescribe` fixes that by construction.

The repo's `pnpm check:e2e-bucketing` enforces the convention; `parityDescribe`
is the way to never trip it. Note the guard blind spot: a helper that passes a
`mode` variable to `useFixture` cannot be statically tied to its title — couple
`mode: "build"` with a `(production)` title inside the helper, which is precisely
what `parityDescribe` does.

## Cross-references

- `/loader` — loader registration, `revalidate`, `ctx.use`, fetchable loaders.
- `/middleware` — middleware signature, scope, short-circuit semantics.
- `/server-actions` — `"use server"`, `useActionState`, validation, PE.
- `/caching`, `/use-cache`, `/cache-guide` — the two freshness axes and stores.
- `/prerender` and [`prerender-api-design.md`](./prerender-api-design.md) —
  prerender = build-time cache; why it is indistinguishable from a cache hit.
- `/typesafety` — compile-time route/param/reverse checking; the generated type
  surfaces behind `assertGeneratedRoutesMatch`.
- [`telemetry.md`](./telemetry.md) — the telemetry sink the cache-decision
  capture path builds on.
