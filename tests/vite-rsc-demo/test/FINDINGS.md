# Dogfooding `@rangojs/router/testing` on vite-rsc-demo — findings

Third dogfood target (after `tests/cloudflare-basic` — the primary findings log —
and `e2e/mini`). Setup is the shipped preset: `resolve: { alias: rangoTestAliases() }`
(node preset). 9 tests across 4 entries: `runMiddleware`, `renderRoute` (`/dom`),
`renderToFlightString` (`/flight`), and the `generated-routes` primitive.

What vite-rsc-demo adds: **real, exported, app-realistic middleware** — the shop
`mockAuthMiddleware` / `requireAuthMiddleware` / `permissionsMiddleware` (each a
`Middleware[]`). `runMiddleware` drives the real chain (auth injects a typed
`user` into ctx; permissions reads it), confirming ctx propagation matches
production. The public `Middleware[]` type passed to `runMiddleware` with no cast.

## Finding (FIXED) — `renderRoute` + `useLoader` didn't work for a REAL loader

> **Resolution:** renderRoute gained a `loaders` option that seeds loaders BY
> REFERENCE — it assigns a synthetic stable `$$id` when the real handle's id is
> empty (bare test) and wires `useLoader` to it. `test/render-route.test.tsx` now
> renders the REAL `CartBadge` (which reads `useLoader(CartLoader)`) via
> `loaders: [[CartLoader, cart]]` with no mock. The same mechanism added
> `locationState` (for `useLocationState`) and `handles` (for `useHandle`)
> seeding. The original analysis is kept below for context.

`renderRoute` seeds `useLoader` reads via `options.loaderData` keyed by the
loader's `$$id`. But a real `createLoader(fn)` handle has **`$$id === ""`** in a
bare test (the id is injected by the Vite plugin at build time). So:

- seeding `loaderData: { [CartLoader.$$id]: cart }` lands the data under the key
  `""`, and `useLoader(CartLoader)` resolves to `undefined`;
- the component then crashes on `data.total` / `data.itemCount`.

The router's own `render-route.test.tsx` sidesteps this by using **mock** loader
objects with an explicit `$$id` (e.g. `{ __brand: "loader", $$id: "loaders/cart#CartLoader" }`).
A consumer testing their REAL component (which imports the real loader) can't do
that. vite-rsc-demo's hook components are almost all `useLoader`-based, so this
blocks `renderRoute` for them; the test here uses a loader-free `useNavigation`
component instead, and `useParams`/`useReverse` renderRoute coverage lives in
cloudflare-basic and mini.

**Recommendation:** either (a) document that `renderRoute` + `useLoader` requires
the component-under-test to receive a loader with a stable `$$id` (so a consumer
must inject a test loader, not import the real one), or (b) let `renderRoute`
seed loader data by a more robust key (e.g. accept `[loader, data]` pairs and key
on object identity, not the empty `$$id`).

## Other notes

- **No response routes** in vite-rsc-demo (no `path.json`-style handlers to
  `dispatch`), and the full router file can't be bare-imported (its page modules
  pull app deps / plugin `virtual:` modules — NOT handler `$$id`, which now falls
  back). So `dispatch` is not exercised here (covered by cloudflare-basic). The
  `generated-routes` primitive is exercised against the real committed
  `NamedRoutes` map + a constructed runtime map.
- The shop middleware call `next()` without `return next()`; `runMiddleware` still
  reports `nextCalled === 1` and a 200 response (the terminal handler ran). That
  matches the app's intent (these are fire-through middleware).
- The e2e harness (`createRangoE2E`) migration to retire this app's ~280-line
  copy-pasted fixture is a separate, larger task (it touches the existing
  Playwright suite); not done in this pass.
