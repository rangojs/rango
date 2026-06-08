# Testing @rangojs/router apps

This is the prose guide. For the dense, decision-tree-first version, see the
[`/testing` skill](../skills/testing/SKILL.md). Both describe the same public
surface, split into six entries by test runtime/dependency:
`@rangojs/router/testing` (unit + integration, under a Vite-driven Vitest
project), `@rangojs/router/testing/vitest` (the `rangoTestConfig`/`rangoTestAliases` setup preset),
`@rangojs/router/testing/dom` (`renderRoute`, needs RTL + a DOM env),
`@rangojs/router/testing/e2e` (the Playwright harness),
`@rangojs/router/testing/flight` (real Flight, react-server condition only), and
`@rangojs/router/testing/flight-matchers` (the Flight matchers).

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

| You ship / consume…                              | Test that…                                                         | Layer               | Primitive                                                                               | Skill                                    |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| `reverse` / `useReverse` / `href`                | the URL is correct; misuse fails to compile                        | unit + types        | call directly; `@ts-expect-error`                                                       | `/typesafety`, `/links`                  |
| a `loader()` body                                | data logic given params/env/vars/search                            | unit (node)         | `runLoader` (handle or raw fn)                                                          | `/loader`                                |
| `middleware()` (auth, logging)                   | ordering, short-circuit, cookie/header merge                       | unit (node)         | `runMiddleware`                                                                         | `/middleware`                            |
| a client component reading router context        | it renders given params/loaderData/Outlet                          | unit (DOM)          | `renderRoute`                                                                           | `/hooks`                                 |
| a component reading `useLocationState`           | it renders the seeded location-state value                         | unit (DOM)          | `renderRoute` (`locationState` option)                                                  | `/location-state`                        |
| a component reading `useHandle` (Breadcrumbs)    | it renders the seeded handle output                                | unit (DOM)          | `renderRoute` (`handles` option)                                                        | `/handles`                               |
| a handle's `collect`/accumulator                 | it maps per-segment pushes to the accumulated value                | unit (node)         | `collectHandle`                                                                         | `/handles`                               |
| a component under an `include('/shop', …)` mount | `useMount`/`useHref`/`useReverse` resolve the prefix               | unit (DOM)          | `renderRoute` (`mount` option)                                                          | `/include`                               |
| a server action's cookie / header / flash output | `Set-Cookie`, response headers, flash — even on `throw redirect()` | unit (node)         | `runInRequestContext` (`{ result, thrown, response, cookies, headers, locationState }`) | `/server-actions`                        |
| a response route (`path.json/.text/...`)         | status, content-type, body, content negotiation                    | integration         | `dispatch`                                                                              | `/response-routes`, `/mime-routes`       |
| a redirect / `404` / middleware redirect         | the `Response` (status + `Location`)                               | integration         | `dispatch`                                                                              | `/middleware`, `/route`                  |
| an async Server Component                        | real Flight output / serialization shape                           | RSC unit            | `renderToFlightString` + `toMatchFlight`                                                | `/route`                                 |
| a client island's props across the boundary      | typed prop fidelity (`Date`/`Map`), inlined-vs-island              | RSC unit            | `renderServerTree` + `findClientBoundaries`                                             | `/route`                                 |
| a real route **handler** `(ctx) => rsc`          | what it renders given params/loaders/vars; its effects             | RSC unit            | `renderHandler` (seeded `HandlerContext`)                                               | `/route`                                 |
| a `"use server"` action + revalidation flow      | the mutate -> reload -> UI update, JS and no-JS                    | e2e                 | `parityDescribe` + `expectParity`                                                       | `/server-actions`                        |
| navigation / hydration / view transitions        | no reload, no page error, correct pathname                         | e2e                 | `parityDescribe`, `waitForHydration`, matchers                                          | `/hooks`, `/view-transitions`            |
| `cache()` / `"use cache"` / loader cache         | hit/miss/stale across two requests                                 | e2e + signal        | `assertCacheStatus` / telemetry sink                                                    | `/caching`, `/use-cache`, `/cache-guide` |
| `Prerender(...)` routes                          | served from a build-time artifact (a cache hit)                    | e2e (prod) + signal | `assertCacheStatus(..., "prerendered")`                                                 | `/prerender`                             |
| the generated `*.named-routes.gen.ts`            | it matches the runtime route map (drift in CI)                     | unit (node)         | `assertGeneratedRoutesMatch`                                                            | `/typesafety`                            |

## What these primitives deliberately don't cover

The unit/integration primitives test the **pieces** (a loader body, a middleware
fn, a seeded component read, a collect fn). They do NOT run the real server, real
Flight round-trip, or the client navigation lifecycle. Several behaviors look
unit-testable but are not — a test can mount/run and go green while proving
nothing. Know these traps, and the seeds that close the easy ones:

| Looks testable, but…                                                                                                                        | Reality                                                                                                                                                                                                                                                                                                                                               | What to do                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useNavigation()` / `useLinkStatus()` / `useAction()` **non-idle** states (loading/streaming/pending, action result/error) in `renderRoute` | `renderRoute.navigate()` bypasses the navigation lifecycle, so the controller never leaves `idle` — you can only assert the idle snapshot                                                                                                                                                                                                             | Test the pending/streaming UI at **e2e**                                                                                                                                                                    |
| `ctx.search` (typed search schema) in a loader                                                                                              | Defaults to `{}`; `opts.search` only sets the raw `ctx.searchParams`                                                                                                                                                                                                                                                                                  | Seed the typed object with **`searchData`** on `runLoader`                                                                                                                                                  |
| `ctx.theme` / `ctx.setTheme` in a handler                                                                                                   | Always `undefined` — the real handler injects the theme config                                                                                                                                                                                                                                                                                        | Pass **`theme`** (the `createRouter({ theme })` shape) to `runLoader`/`runMiddleware`/`renderRoute`                                                                                                         |
| `redirect()` basename prefixing                                                                                                             | Defaults to no prefix                                                                                                                                                                                                                                                                                                                                 | Seed **`basename`** on `runLoader`/`runMiddleware`; `dispatch` uses the router's own basename                                                                                                               |
| a `middleware()` reading handle data (`ctx.use(Handle)` after `ctx.rendered()`)                                                             | Middleware runs **before** the render barrier, so it has no post-barrier handle access in production — `runMiddleware` has no `handles`/`rendered` by design (only `runLoader` does, because only loaders run after the barrier)                                                                                                                      | Read handle data in a **loader/handler** and seed it with `runLoader`'s `handles`/`rendered`                                                                                                                |
| your real `/m/:slug` **component-route** middleware chain (the guard stack)                                                                 | `dispatch` runs the real route-level middleware chain for **response** routes, but throws on component routes; `renderToFlightString`/`renderRoute` don't run route middleware                                                                                                                                                                        | Assert a component route's guard stack at **e2e**, or extract the middleware fn and unit-test it directly with `runMiddleware`                                                                              |
| `dispatch(router, { request })` as a full request→response                                                                                  | Runs the real **global + route-level** middleware chain for **response** routes (so a guard stack IS exercised); throws on RSC/component routes; rejects actions; a `_rsc_partial` request to a response route runs global mw then returns `X-RSC-Reload` (route mw skipped, like prod); else response routes + redirects + 404 + content negotiation | Use `renderToFlightString` (Flight) or e2e for anything that renders                                                                                                                                        |
| `renderToFlightString` of a realistic page                                                                                                  | Pure **leaf / server-only** — a client island emits an un-hydratable `I[...]` row                                                                                                                                                                                                                                                                     | Keep Flight tests to leaf server components; test full pages at e2e                                                                                                                                         |
| streaming `use(promise)` Suspense content (e.g. async breadcrumb `content`) in `renderRoute`                                                | a plain resolving promise's Suspense **retry does not flush** in RTL — the DOM stays on the fallback                                                                                                                                                                                                                                                  | Assert the pending **fallback**; for the arrived state pass a **settled** promise (see the Catch under renderRoute), or use e2e                                                                             |
| `"use cache"` / `cache()` hit/miss/stale in a loader or `dispatch`                                                                          | Without `cacheStore`/`cacheProfiles` seeded, `registerCachedFunction` **bypasses** — the fn runs **uncached**, so taint/profile/invalidation never fire and a green test proves nothing about caching                                                                                                                                                 | Real hit/miss/stale is **e2e + cache signal** (`assertCacheStatus`); seed `cacheStore`/`cacheProfiles` only to exercise the request-scope (NOCACHE) guard                                                   |
| importing your real **whole router file** (`import { router }`) into a bare test                                                            | the file's page modules may pull their own deps or plugin `virtual:` modules that need the rango plugin. (Handler `$$id` is NOT the blocker — `Prerender()` / `createLoader()` / `Static()` all construct via a runtime fallback id.)                                                                                                                 | Build the router from a focused **importable include** (e.g. your API routes) for `dispatch` / `assertGeneratedRoutesMatch`; run whole-router checks at **e2e** (see Setup → "Resolving `@rangojs/router`") |
| a loader that `await`s `ctx.rendered()` then reads accumulated handles                                                                      | `runLoader` seeds handle pushes directly — it does **not** run the real push→accumulate→barrier chain, so a loader that crashes on **empty** post-barrier handles can pass when seeded but still fail in prod                                                                                                                                         | Seed the expected `rendered`/`handles` on `runLoader`; assert the full barrier wiring at **e2e**                                                                                                            |

The **real wiring** is e2e by construction and intentionally out of scope here:
server actions + revalidation, `cache()` hit/miss/stale over real requests,
prerender serving, progressive-enhancement parity, the Flight serialize→hydrate
round-trip, and server→client reference identity (the remount-bug class — a
client reference must resolve to the same client reference, which only a real
hydrated render exercises). The serialize→deserialize half of that round trip IS
available in-process via `renderServerTree` (assert a client boundary's typed
props and inlined-vs-island — see below); what stays e2e is the **hydrate +
click** half. An interactive, clickable `renderServer` (hydrate the deserialized
tree and click it in the test) is a deliberate non-goal at the unit layer:
hydrating in happy-dom re-tests React more than your app and misses the only
hydration bug worth a dedicated test (server/client divergence needs a real
browser). So "does my async Server Component render, hydrate, and respond to a
click" is an **e2e** question by construction. For all of these, reach for
`createRangoE2E` / `parityDescribe` / `assertCacheStatus`.

There is one more boundary, and it is yours, not a layer ceiling: **platform
bindings** (`env.DB`, Durable Objects, `env.R2`). The moment a loader/middleware/
action touches one, it has left rango and entered your app's I/O — rango ships no
doubles for these by design (they are app- and schema-specific). Inject your own
double through the `env` option every primitive takes
(`runLoader(body, { env: { DB: fakeD1 } })`, likewise `runMiddleware` /
`runInRequestContext`). Budget for it: this is usually the biggest single effort
in a consumer suite, and the work is matching the **driver contract**, not the
binding's public API. Concretely, a `D1Database` double for **`drizzle-orm/d1`**
must serve **positional row arrays in schema-column order** for drizzle's `.raw()`
path (with driver-level encodings so the decoder round-trips `Date`/JSON), not
`{ column: value }` objects — an object-shaped double returns silently-wrong or
empty rows. That contract is per-method: drizzle-d1 serves SELECTs through
`.raw()` (the positional rows above), but writes (INSERT/UPDATE/DELETE) go
through `.run()`, which returns `{ success, meta }` — no rows — and bypasses the
row responder entirely. A double must model **both** paths; a read-only `.raw()`
double silently no-ops every write. Build the double at the binding boundary; do
not mock a rango primitive to avoid it.

## Setup

### Dependencies

Install vitest plus the optional peers for the layers you use:

```bash
pnpm add -D vitest @testing-library/react @testing-library/dom happy-dom @playwright/test
```

- `vitest` — the unit/integration/RSC test runner. The router internals import
  the `@rangojs/router:version` virtual module, so a plain-node Vitest cannot
  load them as-is; use the **`rangoTestConfig()` preset** (next section) to
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
import { rangoTestConfig } from "@rangojs/router/testing/vitest";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.{test,spec}.{ts,tsx}"],
    environment: "node", // renderRoute tests use a `// @vitest-environment happy-dom` pragma
    // `preset: "cloudflare"` also stubs the cloudflare:workers / cloudflare:email
    // runtime virtuals a Cloudflare app's route tree imports (default: "node").
    ...rangoTestConfig({ preset: "cloudflare" }),
  },
});
```

`rangoTestConfig()` returns the resolve `alias` entries AND
`server.deps.inline: [/@rangojs[/\\]router/]`, spread together into `test`. The
aliases point the bare `@rangojs/router` at its real impls and stub the
build-only `@rangojs/router:version` and `@vitejs/plugin-rsc/rsc` virtuals — so
you do **not** need a per-file `vi.mock("@vitejs/plugin-rsc/rsc")`.

The `deps.inline` half is mandatory for an installed (node_modules) consumer:
`@rangojs/router` ships as TypeScript source, Vitest externalizes node_modules by
default, and Node >= 23 refuses to type-strip `.ts` under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). `deps.inline` forces Vite, not
Node, to transpile rango's source under test. The preset entry itself ships as
compiled JS, so the `import { rangoTestConfig }` line loads under plain Node
config loading. (In this monorepo `deps.inline` is a no-op — the workspace
symlink resolves to a realpath outside node_modules that Vite already transpiles
— which is exactly why the contract has to be shipped rather than discovered
in-repo. If you want only the aliases, `rangoTestAliases()` is still exported;
then wire `server.deps.inline` yourself.)

**`Prerender()`, `createLoader()`, and `Static()` construct now** — each assigns
a process-stable runtime fallback `$$id` **only under a test runner**
(`process.env.VITEST`), so a router using them builds without the "missing
`$$id`" throw. Outside a test runner (a real build) a missing id still throws, so
an unsupported handler shape the plugin skipped (e.g. `export let X = Static(...)`)
fails loud rather than getting a silent synthetic id — the plugin always injects
for supported `export const` shapes, and the static manifest keys on that id.

**The remaining caveat is the whole router _file_.** Importing your real
`router.tsx` can still fail on app-specific page-module imports (a page pulling
its own deps) or plugin `virtual:` modules that need the rango plugin. For
whole-router `dispatch` / drift checks, build from a focused include (e.g. your
API routes), or run them at e2e.

### Two vitest projects

You need two, because real Flight rendering requires the `react-server` node
condition, and that condition flips React to its server (no client hooks) build —
which would break every client/`renderRoute` test.

The Flight project needs **both** `resolve.conditions: ["react-server"]` **and**
the bare `@rangojs/router` → `index.rsc.ts` alias from `rangoTestAliases`. The
alias is not optional once you render anything that reads the request context: a
handler (or server component) that imports `getRequestContext()` / `cookies()`
from the bare `@rangojs/router` resolves to the **out-of-react-server stub**
(which throws `"… only available in a react-server environment"`) when only
`resolve.conditions` is set — Vite does not reliably apply the condition to
bare-package export resolution. The alias points at `index.rsc.ts`, which **is**
the react-server build (real impls), so it does not conflict with the server
React build. (Pure leaf server components that never touch the request context
work without it — which is why this used to be omitted.) Symptom when missing:
`renderHandler` returns `tree: undefined` with the stub error on `thrown`.

`vitest.config.ts` (the default node + DOM project) — uses the preset, above.

`vitest.rsc.config.ts` (the Flight project):

```ts
import { defineConfig } from "vitest/config";
import {
  rangoInlineDeps,
  rangoTestAliases,
  rangoUseClientTransform,
} from "@rangojs/router/testing/vitest";

// Force production React in this process and any forked worker (forks inherit
// process.env). Dev NODE_ENV crashes the bare worker (jsxDEV owner-stack
// machinery is uninitialized) and also emits volatile debug rows in the Flight
// payload, defeating stable snapshots.
process.env.NODE_ENV = "production";

export default defineConfig({
  // Applies the "use client" transform so renderServerTree resolves client
  // islands from a server tree's own imports — no clientComponents to pass.
  // Server components are untouched (renderToFlightString of leaf trees is
  // unaffected). Omit it only if you don't use renderServerTree.
  plugins: [rangoUseClientTransform()],
  resolve: {
    conditions: ["react-server"],
    // Bare @rangojs/router -> index.rsc.ts (real react-server impls), so a
    // rendered handler/component reading getRequestContext()/cookies() does not
    // hit the throwing stub. Use the same preset as your node project.
    alias: rangoTestAliases({ preset: "cloudflare" }), // or { preset: "node" }
  },
  test: {
    globals: true,
    include: ["**/*.rsc-test.{ts,tsx}"],
    pool: "forks",
    // Vitest 4: top-level pool option. Force the condition on the forked
    // worker, or React throws "the react-server condition must be enabled".
    execArgv: ["--conditions=react-server"],
    // Force Vite (not Node) to transpile @rangojs/router's TS source. MANDATORY
    // for an installed consumer on Node >= 23, which otherwise refuses to
    // type-strip .ts under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
    server: { deps: { inline: rangoInlineDeps } },
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

### Loaders — the raw body or a registered `createLoader`

`runLoader` runs a loader against a real `RequestContext` (cookies, headers,
`ctx.get`, `ctx.reverse` all resolve) in plain node. Pass **either** a registered
`createLoader()` handle **or** the raw async body `(ctx) => ...`.

How the handle works without a build: `createLoader(fn)` normally gets its `$$id`
injected by the Vite plugin (`path#export`) for RSC registration. In a bare
vitest process there is no transform, so `createLoader` assigns a process-stable
runtime-fallback `$$id` and registers its fn under it — which happens when the
handle is imported through the SERVER build, the build `@rangojs/router` resolves
to under the `rangoTestConfig()` preset. `runLoader(ProductLoader, ...)` then
recovers that fn from the registry and runs it. (A handle imported through the
CLIENT build has its body dropped, so `runLoader` throws a clear error telling
you to import through the preset or pass the raw body.) Exporting the body
separately is therefore optional — no longer a testability requirement:

```ts
import { runLoader } from "@rangojs/router/testing";

// loaders/product.ts
export const ProductLoader = createLoader(async (ctx) => {
  const product = await ctx.env.DB.get(ctx.params.id);
  if (!product) return { product: null };
  return { product, self: ctx.reverse("product", { id: ctx.params.id }) };
});

// product.test.ts — pass the registered handle directly (no body extraction)
it("returns the product and a self link", async () => {
  const data = await runLoader(ProductLoader, {
    params: { id: "42" },
    env: { DB: { get: async () => ({ name: "Widget" }) } },
    routeMap: { product: "/products/:id" }, // required for ctx.reverse
  });
  expect(data.product.name).toBe("Widget");
  expect(data.self).toBe("/products/42");
});

// Or pass the raw body — identical behavior, no createLoader needed:
//   const data = await runLoader(async (ctx) => ({ ... }), { params: { id: "42" } });
```

Options: `params` (also surfaced as `routeParams`), `search`/`searchData`, `env`,
`vars` (an object `{ key: value }`, or `[key, value]` tuples where the key may be
a `createVar()` handle), `method`/`body`/`formData`, `routeMap`/`routeName`,
`loaders` (seed `ctx.use(OtherLoader)` by reference as `[[OtherLoader, data]]`
tuples — the same shape as `renderHandler`/`renderRoute`; checked before `use`),
and `use` (a dynamic resolver for `ctx.use(OtherLoader)`; `loaders` wins when both
match). Without either, `ctx.use` runs a dependency's own `fn` if it carries one. In the body, `ctx.reverse` accepts any
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
  const { response, ctx, nextCalled } = await runMiddleware(setSession, {
    request: "/",
  });
  expect(nextCalled).toBe(1); // passed through
  expect(ctx.cookies().session).toBe("abc"); // observable on ctx
  expect(
    response.headers.getSetCookie().some((c) => c.startsWith("session=abc")),
  ).toBe(true);
});
```

`nextCalled` is `0` on short-circuit, `1` on pass-through. The result also carries
`cookies`, `headers`, and `locationState` (a flash set via `setLocationState` or
`redirect({ state })`) as effective views, parity with `runInRequestContext`. The
returned `ctx` is the underlying `RequestContext`. The request the chain runs
under is `opts.request`. Seed prior state with `vars`, model the downstream route
with `next`, enable `ctx.reverse` with `routeMap`/`routeName`, pass an array to
run several in order.

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
    { request: "/users/alice" },
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
the same plugin-injected-id reason. Handle data is accumulated GLOBALLY (not
scoped per segment like loaders), so a LAYOUT component reading a handle (a
`DetailLayout`/`ActionToolbar`) sees the seeded values just as the leaf does. A
component reading only `useParams` / `useReverse` / `useNavigation` needs no
seeding.

Model an `include('/shop', …)` mount with the `mount` option: it wraps the
segment chain in a MountContext exactly as production does, so `useMount()`
returns the prefix and `useHref`/`useReverse` resolve mount-prefixed URLs. A
mount-relative subtree (e.g. `/c/:slug` mounted at `/shop`) is then reproducible
at the unit layer instead of e2e-only:

```tsx
const { getByTestId } = await renderRoute(
  [{ path: "/c/wine", Component: ProductPage }],
  { mount: "/shop", request: "/c/wine" },
);
// useMount() -> "/shop"; useReverse({ product: "/c/:slug" })("product", { slug: "wine" }) -> "/shop/c/wine"
```

Optional params vs an include mount — two different prefixes, don't confuse them.
An optional param that is part of the matched PATTERN (`/:locale?/c/:group` at
`/en/c/wine`) is auto-filled from the current match by `useReverse` exactly like
production: `reverse("group", { group: "food" })` returns `/en/c/food` (the
`locale: "en"` from `useParams()` is merged in) — **no `mount` needed**. Use
`mount` only when the prefix is an `include()` MOUNT — including a param-bearing
mount like `include("/:locale?", …)`, which resolves to a concrete prefix you
pass as `mount: "/en"`. (If a locale "drops" from a reversed URL in a test, the
cause is usually a missing `mount` seed, not an auto-fill gap.)

#### Catch: streaming `use(promise)` Suspense content

Some components render an `async`/streamed value via React `use()` inside a
`<Suspense>` (e.g. a breadcrumb whose `content` is a `Promise<ReactNode>` that
streams in). Two states, two recipes — and one trap:

- **Pending (the fallback):** pass a never-resolving `new Promise(() => {})` as the
  streamed value and assert the `<Suspense>` fallback (skeleton) is mounted.
- **Arrived (the resolved content):** pass an **already-settled** promise carrying
  React's tracking fields, so `use()` reads it synchronously:

  ```ts
  function settled<T>(value: T): Promise<T> {
    const p = Promise.resolve(value) as Promise<T> & {
      status: "fulfilled";
      value: T;
    };
    p.status = "fulfilled";
    p.value = value;
    return p;
  }
  // handles: [[Breadcrumbs, [{ label, href, content: settled(<span>(3 posts)</span>) }]]]
  ```

- **The trap:** a plain `Promise.resolve(node)` does **not** work for the arrived
  state. In a bare RTL/happy-dom test React's Suspense **retry** after a pending
  `use()` promise resolves does not flush — the render isn't inside an awaited
  `act`, and `renderRoute` does its render internally — so the DOM stays stuck on
  the fallback even after you `await` the promise (you'll see "A suspended resource
  finished loading … not wrapped in act"). The pending→resolved _transition_ over a
  real promise is an **e2e** concern; `settled()` gives a deterministic "arrived"
  state for the unit layer.

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

### Type-level tests — make misuse fail to compile

The reverse/href/params types are a real contract: a wrong route name, a missing
param, an unknown env binding should be a **compile error**, not a runtime
surprise. That contract is the highest signal-per-cost test you can write, but it
runs at typecheck time, not in the vitest runner — so it needs its own layer.
Three blessed recipes, smallest first:

1. **Negative assertions inline with `@ts-expect-error`.** Put the misuse right
   next to the valid call; the directive ERRORS if the line below it ever starts
   compiling (i.e. if the type guard regresses). Validated by `pnpm run
typecheck` (or `tsc --noEmit`), which a runtime test cannot do:

   ```ts
   const reverse = useReverse({ post: "/blog/:slug" });
   reverse("post", { slug: "hi" }); // ok
   // @ts-expect-error - "comment" is not a route in this map
   reverse("comment", { id: "1" });
   // @ts-expect-error - missing required :slug param
   reverse("post", {});
   ```

2. **Positive assertions with `expectTypeOf` (vitest).** For pinning an INFERRED
   type (a loader's return type, a parsed search schema, a handle's accumulated
   shape), use vitest's `expectTypeOf` in a normal `*.test.ts` — it validates the
   type relationship as a side effect of the runtime test:

   ```ts
   import { expectTypeOf } from "vitest";
   expectTypeOf(await runLoader(cartLoader)).toEqualTypeOf<{ count: number }>();
   expectTypeOf<RouteParams<"/blog/:slug">>().toEqualTypeOf<{ slug: string }>();
   ```

3. **A dedicated `*.test-d.ts` + tsconfig, for a large type suite.** Collect
   type-only tests in `*.test-d.ts` files and add a `tsconfig.types.json` that
   `extends` your base config and `include`s only those files, then run
   `tsc -p tsconfig.types.json --noEmit` in CI. This is exactly how this repo
   pins its own augmentation contracts (`src/__augment-tests__/*.check.ts` via
   `tsconfig.augment-check.json`). Use it when inline assertions start cluttering
   runtime tests; recipe 1 is enough for most apps.

Whichever you pick, wire it into CI as a real step — a type test that nobody runs
is a comment.

## Integration

### dispatch — request to Response, plus the vi.mock requirement

`dispatch` runs the router's real matching + middleware (reusing
`previewMatch`), with no RSC render. It covers redirects, 404s, response routes,
and global + route-level middleware short-circuits. An RSC (component) route
throws a clear directive error.

This means `dispatch` IS the way to exercise a **response** route's real
route-level middleware chain (the guard stack) against the actual registered
tree — not a hand-built include. The one gap: a **component** route's guard stack
cannot be run here (dispatch refuses component routes, and `renderToFlightString`
/ `renderRoute` don't run route middleware). For that, assert at e2e, or extract
the middleware function and unit-test it directly with `runMiddleware`.

Setup: use the `rangoTestConfig()` preset (above) so `@rangojs/router` resolves
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

it("serializes a JSON response route as the bare handler value", async () => {
  const res = await dispatch(router, { request: "/health" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(
    "application/json;charset=utf-8",
  );
  expect(await res.json()).toEqual({ status: "ok" });
});

it("maps a thrown RouterError to its status + RFC 9457 problem+json", async () => {
  const res = await dispatch(router, { request: "/products/999" }); // handler throws RouterError 404
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toBe(
    "application/problem+json;charset=utf-8",
  );
  const problem = await res.json();
  expect(problem.code).toBe("NOT_FOUND"); // { title, status, detail, code }
});

it("returns 404 for an unmatched path", async () => {
  expect((await dispatch(router, { request: "/nope" })).status).toBe(404);
});
```

`dispatch` also covers trailing-slash/redirect targets (`findMatch`) — a
redirected path returns a 308 with the `Location` (query preserved). A JSON
response route serializes the handler's return value verbatim (no envelope),
and a thrown error becomes an RFC 9457 problem+json body
(`application/problem+json`). Cookies and `ctx.header(...)` set inside a
response-route handler surface on the returned `Response`. Pass env via
`{ env }`.

### runInRequestContext — the handler / server-action test primitive

`runInRequestContext(fn, opts)` is **the** way to unit-test a route handler or
server action — any function that reads the request (`getRequestContext()`,
`cookies()`, `ctx.get(var)`) and produces side-effects (a `Set-Cookie`, a
response header, a flash, a redirect). It builds a real `RequestContext` (same
`opts` as the other primitives — `env`, `request`, `vars`, `params`, …) **and
enters it**, runs `fn` (sync or async), then hands back a typed snapshot of
everything the handler touched — captured whether `fn` **returns or throws**, so
the dominant "`throw redirect()` on success" path needs no try/catch:

```ts
const { result, thrown, response, cookies, headers, locationState } =
  await runInRequestContext(() => loginAction(input), {
    env,
    request: new Request("https://app.test/login", {
      headers: { Cookie: "sid=abc" },
    }),
  });
```

| Field           | What it holds                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `result`        | `fn`'s awaited return, or `undefined` if it threw                                                                                                |
| `thrown`        | what `fn` threw (a redirect/`notFound` `Response` on the success path) — captured, **not** re-thrown; assert on it                               |
| `response`      | the merged `Response` (status + headers + Set-Cookie); a thrown redirect's `Location` merged with the accumulated cookies                        |
| `cookies`       | effective `{ name: value }` cookie view (request cookies + run mutations, last-write-wins)                                                       |
| `headers`       | response headers as `{ name: value }`, **excluding** `set-cookie` (that's `cookies`), including a thrown redirect's `Location`; names lowercased |
| `locationState` | the flash the handler set (`ctx.setLocationState()` / `redirect({ state })`), as the `{ key: value }` the client reads                           |

```ts
expect(cookies.session).toBe("new-token"); // Set-Cookie, parsed
expect(headers["cache-control"]).toBe("no-store"); // a header the handler set
expect(headers.location).toBe("/app"); // the thrown redirect's target
expect(locationState).toEqual({ flash: { text: "Welcome back" } });
```

Reading **vars the handler set** is via the context, not the snapshot: pass
`vars` to seed, and read with `ctx.get(token)` (the `fn` receives `ctx`, or use
the low-level `createTestRequestContext` + `runWithRequestContext`). A
self-describing "vars the handler set" map is intentionally not provided —
`createVar()` keys are anonymous symbols with no reverse lookup, so such a map
could neither name the vars nor separate set-by-handler from seeded.

`runMiddleware` returns the same `cookies` / `headers` snapshot (plus `ctx`,
`response`, `nextCalled`) for asserting a middleware's header/cookie effects.

`runInRequestContext` asserts a handler's **effects** (cookies/headers/flash/
redirect/return value) — it runs under client React and does NOT render RSC. When
the handler **returns RSC** and you want to assert what it _rendered_, use
`renderHandler` (RSC project) — it builds the real `HandlerContext`, calls the
handler, and gives you the deserialized tree (plus the same effects). See
"renderHandler — run a real route handler" below.

### renderToFlightString — real async Server Components

> **Reach for `renderServerTree` (below) by default** when asserting on a Flight
> render — it returns a traversable tree with typed boundary props. Use
> `renderToFlightString` + the wire-string matchers only when you specifically
> need to pin the **wire payload shape** (a `toMatchFlight` snapshot), which is
> the niche/advanced case.

Under the react-server vitest project (`*.rsc-test.{ts,tsx}`, run via
`pnpm test:unit:rsc`):

The matchers live at the separate `@rangojs/router/testing/flight-matchers`
subpath (they import `vitest`); `renderToFlightString` itself does not pull in
Vitest. A **pure leaf** (data in as props) is the simplest case; a component that
imports a server API from the `@rangojs/router` barrel (`getRequestContext`,
`cookies`) also works as long as the rsc project aliases the barrel (see the
caveat below):

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
payload. `renderToFlightString` options (`request`, `headers`, `env`, `params`,
`routeName`, `vars`) set up the request context for a component that genuinely needs it
via internal imports — but a **consumer** importing those server APIs from the
barrel hits the caveat below, so prefer props.

Scope: `renderToFlightString` returns the wire STRING. A client component in the
tree emits an `I[...]` row against its empty client manifest — fine for
snapshotting the payload shape with `toMatchFlight`. To inspect a client
boundary's props as real values, or to detect inlined-vs-island, use
`renderServerTree` (below). A fully interactive, clickable DOM `renderServer`
(hydrated, with state and clicks) is intentionally NOT shipped: in-process
happy-dom hydration re-tests React more than your app and misses the only
hydration bug worth a dedicated test (server/client divergence, which needs a
real browser). Test interactive behavior at e2e.

### renderServerTree — serialize then deserialize to an inspectable tree

Same react-server vitest project. `renderServerTree` serializes the real Flight
(identical bytes to `renderToFlightString`) and then deserializes it back to a
React element tree you can traverse. The unique win over the wire string: a
client boundary's props come back as **real JS values** (a `Date` is a `Date`,
not the opaque `$D...` encoding), and you can confirm a `"use client"` component
actually crossed the boundary (an `I` row) instead of being inlined. There is NO
hydration and NO interaction — boundaries are inert placeholders carrying props.

With `rangoUseClientTransform()` wired into the Flight project (above), client
islands are **auto-discovered** from the server tree's own imports — you pass
nothing:

```tsx
import { it, expect } from "vitest";
import {
  renderServerTree,
  findClientBoundaries,
} from "@rangojs/router/testing/flight";
import { PriceTag } from "./PriceTag.js"; // a "use client" component (any filename)

async function ProductPanel({ amount, asOf }: { amount: number; asOf: Date }) {
  await Promise.resolve();
  return <PriceTag amount={amount} currency="USD" asOf={asOf} />;
}

it("client props survive the serialize -> deserialize round trip", async () => {
  const { flight, tree } = await renderServerTree(
    <ProductPanel amount={19.5} asOf={new Date("2026-01-02T00:00:00Z")} />,
  );
  expect(flight).toMatchFlight("PriceTag"); // wire assertions still work

  const [tag] = findClientBoundaries(tree, "PriceTag");
  expect(tag.props.amount).toBe(19.5); // a real number
  expect(tag.props.asOf).toBeInstanceOf(Date); // a real Date, not "$D..."
});
```

`findClientBoundaries(tree, selector?)` returns every boundary (each
`{ id, name, props, element }`) in document order; it always returns an array, so
destructure `const [tag] = …` for a single expected island and assert on
`.length` when the count matters (no match yields `[]`). The selector is either a
**string** (match by export name) or an object that filters by `name` / `testId`
/ `props` (subset deep-equal, Date/Map/Set/array aware) / `where`, all AND-ed:

```ts
findClientBoundaries(tree, "PriceTag"); // by export name
findClientBoundaries(tree, { testId: "primary-cta" }); // by props["data-testid"]
findClientBoundaries(tree, { name: "PriceTag", props: { currency: "USD" } });
findClientBoundaries(tree, { where: (b) => (b.props.amount as number) > 100 });
```

A `testId` matches a `data-testid` you passed **as a prop** to the island
(`<PriceTag data-testid="primary-cta" />`) — it crosses the boundary. A
`data-testid` rendered on a plain server host element is not a boundary; select
those with **`findElements`** (next). Same **pure-leaf** caveat as
`renderToFlightString` applies to the server component (don't import server-only
APIs).

#### findElements / textContent — select the server-rendered tree

`findClientBoundaries` finds client islands; `findElements(tree, selector?)`
finds the **server/host elements** a server component rendered (`<article>`,
`<h2>`, …) — each `{ tag, type, props, children, text, element }`, in document
order, always an array. The selector is a host **tag string** (`"h2"`) or an
object filtering by `tag` / `testId` / `props` (subset deep-equal) / `text`
(substring or `RegExp`) / `where`:

```ts
import { findElements, textContent } from "@rangojs/router/testing/flight";

const [h2] = findElements(tree, "h2");
expect(h2.text).toBe("Wine");
findElements(tree, { testId: "subtitle" }); // data-testid on a host element
findElements(tree, { tag: "article", text: /in stock/i });
expect(textContent(tree)).toContain("Wine"); // instead of JSON.stringify(tree)
```

`textContent(node)` concatenates every string/number leaf of a node's subtree —
the clean way to assert rendered text. **Caveat:** server _components_ do not
survive Flight as identities (they are executed during serialization), so
`findElements` matches the host elements they produced, not the component
function. Client islands keep identity — use `findClientBoundaries` for those.

`renderServerTree` renders an **element** you build (`<Page />`). `vars` seeds
`ctx.get(MyVar)` for a server component that reads `getRequestContext()` during
render; cookies via `headers`, params via `params`. To test a route **handler**
(a `(ctx) => rsc` function, what you pass to `path(...)`), use **`renderHandler`**
(below) — it builds the real `HandlerContext` and calls the handler for you.

**Fallback without the transform.** If you don't wire `rangoUseClientTransform()`,
a plainly-imported island is just an unmarked function the serializer would render
server-side. Register islands explicitly instead — list the components you already
import (no filename convention; `"use client"` is a directive, not a name):

```tsx
const { tree } = await renderServerTree(<ProductPanel … />, {
  clientComponents: { PriceTag },
});
```

Consumer caveat: a server component (or handler) that imports a server API from
the `@rangojs/router` **barrel** (e.g. `getRequestContext`, `cookies`) works in
the Flight project **only if** that project aliases the bare specifier to
`index.rsc.ts` via `rangoTestAliases` (see "Two vitest projects" above). The
alias points at the real react-server impls, so it does **not** crash the server
React build — it leaves React itself untouched and only redirects
`@rangojs/router`. Without the alias the bare specifier resolves to the throwing
out-of-react-server stub (symptom: `renderHandler` returns `tree: undefined`, the
stub error on `thrown`). With the alias wired, `renderToFlightString` enters
`runWithRequestContext` for you and `renderServerTree`/`renderHandler` seed the
context (vars/headers/params), so barrel-importing components are testable. (Pure
leaf components that take all data as props need no barrel import at all and are
the simplest case — but they are no longer the only supported one.)

### renderHandler — run a real route handler and assert its RSC

A Rango route handler is a pure function `(ctx) => rsc` — the function you pass to
`path("/p/:slug", ProductPage)`, NOT a component. `renderHandler` runs it with the
real `HandlerContext` the router builds (so `ctx.params`, `ctx.use(Loader)`,
`ctx.use(Meta)`/`ctx.use(Breadcrumbs)`, `ctx.reverse`, `ctx.get` all work), then
serializes the returned RSC and deserializes it to an inspectable tree. Loaders
are **seeded** (no real loader run — same model as `runLoader`):

```tsx
import {
  renderHandler,
  findClientBoundaries,
} from "@rangojs/router/testing/flight";
import { ProductPage } from "../src/pages/product"; // the real handler: (ctx) => rsc

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
```

Result: `{ tree, flight, thrown, response, cookies, headers, locationState, handles }`.
The handler's **effects** are surfaced (cookies/headers/flash) and a
`throw redirect(...)` is captured on `thrown` (with `tree` undefined, since it
produced a `Response`) — exactly like `runInRequestContext`, plus the rendered
RSC. `handles` is a `Map<Handle, pushed[]>` of what the handler pushed via
`ctx.use(Handle)`. An unseeded `ctx.use(loader)` rejects with a clear setup error.

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
// In a Playwright e2e, import the cache-status helpers from the e2e entry —
// the `@rangojs/router/testing` barrel pulls a build-only virtual that does
// not resolve in a plain Playwright runner.
import { assertCacheStatus } from "@rangojs/router/testing/e2e";

parityDescribe("product page caches", (f) => {
  test("second request is a hit", async ({ page }) => {
    // The key is the route NAME (the X-Rango-Cache id), NOT the URL pattern.
    assertCacheStatus(
      await page.request.get(f.url("/products/1")),
      "product.detail",
      "miss",
    );
    assertCacheStatus(
      await page.request.get(f.url("/products/1")),
      "product.detail",
      "hit",
    );
  });
});
```

Statuses: `hit | miss | stale | prerendered | passthrough`. v1 is COARSE
(route-level, keyed by the route key — the route NAME, e.g. `product.detail`, NOT
the URL pattern), not per-individual-segment. `parseCacheHeader` exposes the raw
`{ routeKey: status }` map if you need it.

**Most tests should use `assertCacheStatus`.** The telemetry sink is the
advanced (zero-prod-surface) alternative — reach for it only when you need
per-segment decision detail rather than the route-level status. No header at
all; you inspect captured `cache.decision` events:

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
// Setup — @rangojs/router/testing/vitest (ships as compiled JS; node-loadable in vitest.config.ts)
rangoTestConfig(opts?: { preset?: "node" | "cloudflare" }): { alias: TestAlias[]; server: { deps: { inline: RegExp[] } } };
// test: { ..., ...rangoTestConfig({ preset: "cloudflare" }) }   // aliases + the required deps.inline
rangoTestAliases(opts?: { preset?: "node" | "cloudflare" }): { find: string|RegExp; replacement: string }[]; // aliases only
rangoInlineDeps: RegExp[];  // the server.deps.inline patterns, if wiring them yourself

// Unit. CONVENTION: the request a primitive runs under is opts.request (a Request
// or a URL string) for every render/run primitive; only the client renderRoute's
// initial location is also opts.request.
// RETURN SHAPE (by design): runLoader -> the loader data directly; dispatch -> a
// Response; the render/run primitives -> an envelope (effect snapshot and/or tree).
runMiddleware(
  mw: Middleware | Middleware[],
  opts: { request: Request | string; env?, params?, vars?, routeMap?, routeName?, basename?, next?: () => Promise<Response> },
): Promise<{ response: Response; ctx: RequestContext; nextCalled: number;
             cookies: Record<string, string>; headers: Record<string, string>;
             locationState: Record<string, unknown> }>;
// `cookies`/`headers`/`locationState` are the effective views — assert what the chain set without the @internal ctx cast.
// const { response, nextCalled, cookies } = await runMiddleware(authMw, { request: "/dashboard", vars: { user: u } });

runLoader<T>(
  loader: ((ctx) => T | Promise<T>) | LoaderDefinition<T>, // raw body OR a registered createLoader() handle
  opts?: { params?, search?, env?, request?, vars?, routeMap?, routeName?, method?, body?,
           formData?, loaders?: [loader, data][], use?, rendered?, handles? },
): Promise<T>;
// A createLoader() handle's fn is recovered from the registry (works through the server build / rangoTestConfig preset).
// vars accepts an object ({ user: u }) or [key, value] tuples ([[userVar, u]]).
// loaders: [[OtherLoader, data]] seeds ctx.use(OtherLoader) by reference (same shape as renderHandler/renderRoute); use = dynamic resolver.
// In the body, ctx.reverse accepts any routeMap name and ctx.get any string/ContextVar.
// rendered: true mocks ctx.rendered(); handles: [[H, accumulated]] seeds ctx.use(H) with the POST-collect value (NOT raw pushes; cf renderRoute).
// const data = await runLoader(ProductLoader, { params: { id: "1" }, env }); // or runLoader(rawBody, ...)

// Component — @rangojs/router/testing/dom (DOM env + @testing-library/react)
renderRoute(                            // async; lazy-loads RTL at call time
  routes: RenderRouteSpec[],            // root->leaf; last = leaf route
  options?: {
    request?: Request | string,         // initial location (URL is read; client render)
    params?, routeMap?,
    loaders?: [loader, data][],         // seed useLoader by REFERENCE (real handles)
    loaderData?: Record<$$id, data>,    // seed useLoader by explicit $$id
    locationState?: [def, value][],     // seed useLocationState by REFERENCE
    handles?: [handle, pushedValues[]][],// seed useHandle by REFERENCE, RAW pushes[] (reaches layouts too)
    handle?,                            // advanced: raw handle wire data
    basename?,                          // createRouter({ basename }) value (Link/href/reverse prefixing)
    mount?,                             // include('/shop', …) prefix -> useMount/useHref/useReverse resolve it
    theme?,                             // createRouter({ theme }) shape (enables useTheme)
  },
): Promise<RenderResult & { router }>;
// const { getByTestId, router } = await renderRoute([{ path: "/p/:id", Component: P }], { request: "/p/1" });
// useLoader:        renderRoute([{ path: "/c", Component: CartBadge }], { loaders: [[CartLoader, cart]] });
// useLocationState: renderRoute([{ path: "/s", Component: FlashBanner }], { locationState: [[FlashMessage, { text: "Saved" }]] });
// useHandle:        renderRoute([{ path: "/p", Component: Trail }], { handles: [[Breadcrumbs, [{ label: "Home", href: "/" }]]] });
// useMount/include:  renderRoute([{ path: "/c/wine", Component: PDP }], { mount: "/shop" }); // useMount() -> "/shop"

// Integration — @rangojs/router/testing
dispatch(router: Rango, opts: { request: Request | string; env? }): Promise<Response>;
// accepts your public router type (no cast); use rangoTestAliases() for setup.
// const res = await dispatch(createRouter().routes(apiPatterns), { request: "/health" });

// RSC — @rangojs/router/testing/flight, react-server vitest project only
renderToFlightString(element, opts?: { request?: Request|string, headers?, env?, params?, routeName?, vars? }): Promise<string>;
flightMatchers; // expect.extend -> toMatchFlight(substring), toMatchFlightSnapshot()
// expect.extend(flightMatchers); expect(await renderToFlightString(<C/>)).toMatchFlight("hi");
renderServerTree(element, opts?: { ...same, clientComponents? }): Promise<{ flight, tree }>;
renderHandler(handler, opts?: { request?, params?, env?, vars?, loaders?, routeMap?, headers?, clientComponents? }):
  Promise<{ tree, flight, thrown, response, cookies, headers, locationState, handles }>;
findClientBoundaries(tree, selector?: string | { name?, testId?, props?, where? }): ClientBoundary[]; // {id,name,props,element}[]; [] if none
findElements(tree, selector?: string | { tag?, testId?, props?, text?, where? }): FoundElement[]; // server/host elements {tag,props,children,text,element}[]
textContent(node): string; // concatenated subtree text (use instead of JSON.stringify(tree).toContain)
rangoUseClientTransform(); // Vite plugin for vitest.rsc.config.ts -> auto-discover islands
// react-server vitest project MUST also alias @rangojs/router -> index.rsc.ts (rangoTestAliases) or a
// handler/component reading getRequestContext()/cookies() hits the throwing stub (tree: undefined).
// renderServerTree renders an ELEMENT; renderHandler runs a route handler (ctx)=>rsc with a seeded ctx.
// const { tree } = await renderServerTree(<Page/>);                       // element
// const { tree, handles } = await renderHandler(ProductPage, { params: { slug: "wine" },
//   loaders: [[ProductLoader, data]], vars: [[Tenant, t]] });             // real handler
// const [tag] = findClientBoundaries(tree, { testId: "cta" }); expect(tag.props.asOf).toBeInstanceOf(Date);
// const [h2] = findElements(tree, "h2"); expect(h2.text).toBe("Wine");   // server/host element (not a boundary)
// fallback (no transform): pass { clientComponents: { PriceTag } } to either

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

// Advanced context construction (for an action / fn that reads getRequestContext()/cookies())
runInRequestContext<T>(fn: (ctx) => T | Promise<T>, opts?):
  Promise<{ result: T | undefined; thrown: unknown; response: Response;
            cookies: Record<string, string>; headers: Record<string, string>;
            locationState: Record<string, unknown> }>;
  // build + ENTER a real ctx in one call; captures the action's OUTPUT whether fn RETURNS or THROWS.
  // result = fn's return (undefined if it threw); thrown = what it threw (a redirect Response on the
  // success path — captured, NOT re-thrown); response = Set-Cookie/headers/status (a thrown redirect's
  // Location merged with the cookies); cookies = effective cookie view; headers = response headers as a
  // plain object (excl. set-cookie; incl. a redirect Location); locationState = the flash.
runWithRequestContext(ctx, fn);                     // low-level: enter a ctx you already built
createTestRequestContext(opts); toRequest(...); seedVariables(...);
// const { cookies, response, thrown } = await runInRequestContext(() => loginAction(input), // sets cookie, throw redirect("/app")
//   { env, request: new Request(url, { headers: { Cookie: "sid=abc" } }) });
// expect(cookies.session).toBe("..."); expect((thrown as Response).headers.get("Location")).toBe("/app");

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
