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

| You ship / consume…                         | Test that…                                      | Layer               | Primitive                                      | Skill                                    |
| ------------------------------------------- | ----------------------------------------------- | ------------------- | ---------------------------------------------- | ---------------------------------------- |
| `reverse` / `useReverse` / `href`           | the URL is correct; misuse fails to compile     | unit + types        | call directly; `@ts-expect-error`              | `/typesafety`, `/links`                  |
| a `loader()` body                           | data logic given params/env/vars/search         | unit (node)         | `runLoader` (raw fn)                           | `/loader`                                |
| `middleware()` (auth, logging)              | ordering, short-circuit, cookie/header merge    | unit (node)         | `runMiddleware`                                | `/middleware`                            |
| a client component reading router context   | it renders given params/loaderData/Outlet       | unit (DOM)          | `renderRoute`                                  | `/hooks`                                 |
| a response route (`path.json/.text/...`)    | status, content-type, body, content negotiation | integration         | `dispatch`                                     | `/response-routes`, `/mime-routes`       |
| a redirect / `404` / middleware redirect    | the `Response` (status + `Location`)            | integration         | `dispatch`                                     | `/middleware`, `/route`                  |
| an async Server Component                   | real Flight output / serialization shape        | RSC unit            | `renderToFlightString` + `toMatchFlight`       | `/route`                                 |
| a `"use server"` action + revalidation flow | the mutate -> reload -> UI update, JS and no-JS | e2e                 | `parityDescribe` + `expectParity`              | `/server-actions`                        |
| navigation / hydration / view transitions   | no reload, no page error, correct pathname      | e2e                 | `parityDescribe`, `waitForHydration`, matchers | `/hooks`, `/view-transitions`            |
| `cache()` / `"use cache"` / loader cache    | hit/miss/stale across two requests              | e2e + signal        | `assertCacheStatus` / telemetry sink           | `/caching`, `/use-cache`, `/cache-guide` |
| `Prerender(...)` routes                     | served from a build-time artifact (a cache hit) | e2e (prod) + signal | `assertCacheStatus(..., "prerendered")`        | `/prerender`                             |
| the generated `*.named-routes.gen.ts`       | it matches the runtime route map (drift in CI)  | unit (node)         | `assertGeneratedRoutesMatch`                   | `/typesafety`                            |

## Setup

### Dependencies

Install vitest plus the optional peers for the layers you use:

```bash
pnpm add -D vitest @testing-library/react happy-dom @playwright/test
```

- `vitest` — the unit/integration/RSC test runner. Run the `@rangojs/router/testing`
  primitives under a **Vite-driven** Vitest config that includes the rango Vite
  plugin: the router internals import the `@rangojs/router:version` virtual
  module, so a plain-node Vitest with no plugin (and no `@rangojs/router:version`
  alias) cannot load them.
- `@testing-library/react` + a DOM env (`happy-dom` or `jsdom`) — required for
  `renderRoute`, which lives at its own entry `@rangojs/router/testing/dom` and
  lazy-loads RTL at call time. Both are optional peers; the `@rangojs/router/testing`
  barrel never references them, so a unit suite testing only loaders/middleware/`dispatch`
  needs neither RTL nor a DOM env.
- `@playwright/test` — required for e2e. It is an optional peer: the e2e harness
  lives at `@rangojs/router/testing/e2e` (a separate entry, loadable in a plain
  Playwright runner) and never imports `@playwright/test` at runtime — you pass
  your own `test`/`expect` into `createRangoE2E`.

### Two vitest projects

You need two, because real Flight rendering requires the `react-server` node
condition, and that condition flips React to its server (no client hooks) build —
which would break every client/`renderRoute` test.

`vitest.config.ts` (the default node + DOM project) — your normal config.

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
(string key or `createVar()` handle), `method`/`body`/`formData`,
`routeMap`/`routeName`, and `use` (resolver for `ctx.use(OtherLoader)`). Without
`use`, `ctx.use` runs a dependency's own `fn` if it carries one.

Unit-only limitations — document them in the test, do not work around them:

- `ctx.reverse(...)` throws without `routeMap`.
- `ctx.rendered()` throws — the DSL render barrier only exists during a full
  match. `ctx.isAction(...)` (action-render context) is likewise unavailable.
  Cover those with e2e (or `renderToFlightString` for render output).

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

The Vite-env / vi.mock requirement: importing your _router_ transitively imports
`@vitejs/plugin-rsc/rsc`, whose top-level body imports Vite virtual modules that
do not resolve in plain node. `dispatch` itself is virtual-free; the router is
not. So either run `dispatch` tests in a Vite-RSC-capable env, or mock the module
before importing the router:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  createFromReadableStream: vi.fn(),
  renderToReadableStream: vi.fn(),
  loadServerAction: vi.fn(),
  decodeReply: vi.fn(),
  decodeAction: vi.fn(),
  decodeFormState: vi.fn(),
  createTemporaryReferenceSet: vi.fn(),
}));

import { dispatch } from "@rangojs/router/testing";
import { router } from "../src/router";

it("emits a 308 redirect for a trailing-slash mismatch", async () => {
  const res = await dispatch(router, "/old?ref=email");
  expect(res.status).toBe(308);
  expect(res.headers.get("Location")).toBe("/old/?ref=email"); // query preserved
});

it("returns 404 for an unmatched path", async () => {
  expect((await dispatch(router, "/nope")).status).toBe(404);
});

it("serializes a text response route", async () => {
  const res = await dispatch(router, "/api/ping");
  expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
  expect(await res.text()).toBe("pong");
});
```

JSON response routes are auto-wrapped as `{ data: <value> }`. Cookies and
`ctx.header(...)` set inside a response-route handler surface on the returned
`Response`. Pass env via `{ env }`.

### renderToFlightString — real async Server Components

Under the react-server vitest project (`*.rsc-test.{ts,tsx}`, run via
`pnpm test:unit:rsc`):

```tsx
import { it, expect } from "vitest";
import {
  renderToFlightString,
  flightMatchers,
} from "@rangojs/router/testing/flight";
import { getRequestContext } from "@rangojs/router";
expect.extend(flightMatchers);

async function Profile() {
  const ctx = getRequestContext(); // request context is active
  return <h1>User {ctx.params.id}</h1>;
}

it("renders an async server component reading params", async () => {
  const flight = await renderToFlightString(<Profile />, {
    url: "http://localhost/users/7",
    params: { id: "7" },
    routeName: "users.show",
  });
  expect(flight).toMatchFlight("User ");
  expect(flight).toMatchFlight("7");
});
```

`toMatchFlight(substring)` is containment on the normalized string (row framing
is an internal detail). `toMatchFlightSnapshot()` snapshots the normalized
payload. Options: `url`, `headers`, `env`, `params`, `routeName`.

Scope: server-only / leaf trees. A client component in the tree emits an
unresolved `I[...]` import row against the empty client manifest — fine for
snapshotting the payload shape, not hydratable. A fully interactive, clickable
DOM `renderServer` (hydrated) is a deferred follow-up: the react-server vs
default condition wall needs a two-environment setup, which v1 does not ship. For
interactive server-component behavior today, use e2e.

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
// Unit
runMiddleware(
  mw: MiddlewareFn | MiddlewareFn[],
  request: Request | string,
  opts?: { env?, params?, vars?, routeMap?, routeName?, next?: () => Promise<Response> },
): Promise<{ response: Response; ctx; nextCalled: number }>;
// const { response, nextCalled } = await runMiddleware(authMw, "/dashboard", { vars: [["user", u]] });

runLoader<T>(
  loaderFn: (ctx) => T | Promise<T>,   // RAW function, NOT createLoader(...)
  opts?: { params?, search?, env?, request?, vars?, routeMap?, routeName?, method?, body?, formData?, use? },
): Promise<T>;
// const data = await runLoader(loaderBody, { params: { id: "1" }, env });

// Component — @rangojs/router/testing/dom (DOM env + @testing-library/react)
renderRoute(                            // async; lazy-loads RTL at call time
  routes: RenderRouteSpec[],            // root->leaf; last = leaf route
  options?: { initialUrl?, loaderData?, params?, handle?, routeMap? },
): Promise<RenderResult & { router }>;
// const { getByTestId, router } = await renderRoute([{ path: "/p/:id", Component: P }], { initialUrl: "/p/1" });

// Integration — @rangojs/router/testing
dispatch(router, request: Request | string, opts?: { env? }): Promise<Response>;
// vi.mock("@vitejs/plugin-rsc/rsc") first; const res = await dispatch(router, "/api/health");

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

// Generated-route drift
diffGeneratedRoutes(router, generatedMap?): { missing, extra, mismatch, ok };
assertGeneratedRoutesMatch(router, generatedMap?): void;
// import NamedRoutes from "./router.named-routes.gen"; assertGeneratedRoutesMatch(router, NamedRoutes);

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
