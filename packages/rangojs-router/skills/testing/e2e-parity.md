# E2E with dev/prod and PE parity — createRangoE2E

**Layer:** e2e (Playwright) · **Import:** `@rangojs/router/testing/e2e` · **DSL it tests:** navigation, hydration, server actions + revalidation, view transitions, PE parity (see `/hooks`, `/view-transitions`)

This is full-stack: the harness builds and serves your real app (`pnpm dev` or `pnpm build` + `pnpm preview`) and drives a real browser. Nothing is seeded — you SEED only the URL you navigate to and the form data you submit; everything else (SSR, hydration, the RSC stream, actions, revalidation) is the real machinery.

## API

`createRangoE2E({ test, expect, defaultRoot })` takes your Playwright `test`/`expect` and returns `{ useFixture, parityDescribe, expectParity, rangoMatchers, testNoJs, ...pageHelpers }`. The factory never imports `@playwright/test` at runtime — the helpers run on the objects you pass, so this entry is loadable in a plain Playwright runner.

### Factory options — `createRangoE2E({ ... })`

| Field         | Type       | Meaning                                                                  |
| ------------- | ---------- | ------------------------------------------------------------------------ |
| `test`        | `TestType` | Your Playwright `test` (drives `describe`/`beforeAll`/`afterAll`).       |
| `expect`      | `Expect`   | Your Playwright `expect` (used by helpers + matchers).                   |
| `defaultRoot` | `string?`  | Fallback app root for `parityDescribe` when a call omits `options.root`. |

### Fixture options — `FixtureOptions` (`useFixture` / `parityDescribe` 3rd arg)

| Field            | Type               | Meaning                                                                        |
| ---------------- | ------------------ | ------------------------------------------------------------------------------ |
| `root`           | `string`           | App path under test (abs or cwd-relative). Required here or via `defaultRoot`. |
| `mode`           | `"dev" \| "build"` | Server mode. `parityDescribe` sets this for you (dev + build).                 |
| `command`        | `string?`          | Override server command (default `pnpm dev` / `pnpm preview`).                 |
| `buildCommand`   | `string?`          | Override build command (default `pnpm build`).                                 |
| `cliOptions`     | `SpawnOptions?`    | Extra spawn options (`env`, etc.).                                             |
| `isolatedServer` | `boolean?`         | Per-suite server with an isolated Vite cache dir (warms dep optimizer; dev).   |
| `readyPath`      | `string?`          | Readiness poll path (default `/`); use when a basename moves routes off `/`.   |
| `skipBuild`      | `boolean?`         | Skip the production build (assumes an existing build).                         |

### Parity intent — `ParityIntent` (what `expectParity` applies)

| Shape                           | Meaning                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `{ navigate: string }`          | Go to a URL (resolved against `opts.baseURL` if relative).                    |
| `{ submit: { testId, data? } }` | Fill `data` into named inputs under `[data-testid=testId]`, click its submit. |

### expectParity options — `ExpectParityOptions`

| Field           | Type                               | Meaning                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe`       | `string[]`                         | data-testid values whose text must match across JS and no-JS.                                                                                                                                                                                                                   |
| `baseURL`       | `string?`                          | Base URL for a relative `navigate` intent.                                                                                                                                                                                                                                      |
| `waitFor`       | `(page) => Promise<void>?`         | Post-intent settle hook on BOTH transports; for `submit` it REPLACES the generic change/stability wait.                                                                                                                                                                         |
| `ignoreCookies` | `ReadonlyArray<string \| RegExp>?` | Cookie names to exclude from the JS/no-JS jar comparison (exact string or RegExp). The rango state cookie (default prefix `rango-state`) is ALWAYS excluded — it is client-only; use this for a custom `stateCookiePrefix` or other volatile/JS-only cookies (analytics, CSRF). |

### Returns

`createRangoE2E(...)` -> `RangoE2E`:

- `useFixture(options)` -> `Fixture` (`{ mode, root, url(url?), proc() }`). `url(path)` resolves against the running server.
- `parityDescribe(name, (f) => { ... }, options?)` -> registers a dev describe `name` AND a production describe `` `${name} (production)` ``. Body runs once per describe with that describe's `Fixture`.
- `expectParity(page, intent, opts) => Promise<void>` — runs `intent` over the JS page and a fresh no-JS context, asserts observed testids' text + pathname/search/hash + `document.cookie` are equal. `opts` is the required `observe` plus optional `baseURL`, `waitFor`, and `ignoreCookies` (the rango state cookie is excluded automatically).
- `rangoMatchers` — `{ toHaveRangoPathname }` only (pass to `expect.extend`).
- `testNoJs` — a `test` variant with JavaScript disabled.
- Page helpers: `waitForHydration`, `expectNoReload`, `expectNoPageError`, `testId`, `waitForNavigation`, `waitForElement`, `goBack`/`goForward`, `getHistoryState`, `waitForTextChange`/`waitForNumericChange`, timing helpers.

## Recipe

```ts
// helper.ts — wire the harness once around your Playwright test/expect.
import { test, expect } from "@playwright/test";
import { createRangoE2E } from "@rangojs/router/testing/e2e";

export const { parityDescribe, expectParity, rangoMatchers, useFixture } =
  createRangoE2E({ test, expect, defaultRoot: "." });
export { test, expect };
```

```ts
// nav.test.ts — one body -> dev describe AND `(production)` describe.
import {
  test,
  expect,
  parityDescribe,
  expectParity,
  rangoMatchers,
} from "./helper";
expect.extend(rangoMatchers);

parityDescribe("product navigation", (f) => {
  test("client-navigates without a reload", async ({ page }) => {
    await page.goto(f.url("/"));
    await page.getByTestId("product-link").click();
    await page.waitForURL("**/products/1");
    await expect(page).toHaveRangoPathname("/products/1"); // typed via the shipped augmentation
  });
});

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

This add-to-cart example only works because the cart is **session-scoped**. A `submit` intent runs against the one live server TWICE — once on the JS page, once in a fresh no-JS context — so `cart-count` lands on the same value on both transports only if each context has its own cart (two distinct sessions, each going 0 -> 2). If the cart were a single global counter shared across contexts, the no-JS pass would observe the JS pass's mutation too (2 then 4) and the snapshots would diverge. See the submit caveats below before reaching for a `submit` intent.

## Caveats

- Every e2e covers BOTH dev and production — a dev-only e2e is not acceptable. `parityDescribe` enforces it structurally: one body registers the dev describe AND the `(production)` describe.
- Bucketing footgun: a `useFixture({ mode: "build" })` describe whose title omits `(production)` silently lands in the DEV bucket — prod coverage lost, no error. Never hand-title a build describe; the bucketing matches the literal `(production)`, so `(prod)`, `-build`, `-prod` do NOT count. Use `parityDescribe`.
- `expectParity` contract: PE parity only holds if the submit target is a real `<form>` (with JS off the browser does a native POST). Cookie observation is `document.cookie` — non-HttpOnly cookies only in v1; an HttpOnly (session/auth) divergence is NOT caught here.

### `submit`-intent parity — two scar-tissue hazards

A `submit` intent does NOT replay against a snapshot of the server — it submits for real, twice, against the one running instance, and then compares two whole browser jars. Both of these have bitten before; read them before you write a `submit` parity test.

- **Double execution.** The JS path submits on the page you handed `expectParity`. The no-JS pass then reloads the SAME `originUrl` in a fresh, scripting-disabled context and submits AGAIN. So a non-idempotent action (anything that mutates server state) runs twice against one server, and the no-JS snapshot sees BOTH mutations — UNLESS the mutated state is per-session / per-context. The add-to-cart example above only passes because the cart is session-scoped: each context owns its own cart and independently goes 0 -> 2, so both snapshots read 2. A globally-shared counter would read 2 after the JS submit and 4 after the no-JS submit, and the equality assertion would fail with no obvious cause. Increment-shaped actions are the trap; make the observable state session-scoped, or assert the submit path outside `expectParity`.
- **Whole jar, not the delta.** The cookie assertion compares `document.cookie` of the JS context against `document.cookie` of the fresh no-JS context (`parity.ts`, the final `cookies` equality). The JS context carries every cookie it accumulated before the intent — consent banners, analytics, cookies set during earlier navigation in the same test. The no-JS context starts empty and only picks up what THIS submit sets. So a pre-existing, intent-unrelated cookie in the JS context false-mismatches: the helper is diffing two jars, not the per-submit cookie delta. Keep the JS context's pre-intent cookie state minimal (a fresh page goto, no prior cookie-setting steps), or assert the specific Set-Cookie in a dedicated test.
- `rangoMatchers` ships `toHaveRangoPathname` only. `toHaveSegments`/`toHaveParams` are a documented future addition — they need a client-emitted signal that does not exist yet; do not assume them.
- Subset run: add `--no-deps`. `--grep` does NOT filter dependency projects, so grepping one production test otherwise pulls in the whole dev suite. `--grep` is a regex: a pasted title containing `(production)` / `:locale?` / `[...]` mis-matches — grep a metacharacter-free fragment (or escape it). Example: `pnpm exec playwright test --project=production --no-deps --grep "add to cart parity"`.
- Import the harness from the `/e2e` entry — the unit barrel (`@rangojs/router/testing`) is not loadable in a plain Playwright runner (it pulls a build-only virtual). The helpers take your `test`/`expect`, so this entry never imports `@playwright/test` at runtime.

## See also

- `/hooks`, `/view-transitions` — the DSL this tests
- Siblings: [`./cache-prerender.md`](./cache-prerender.md), [`./client-components.md`](./client-components.md)
- Long-form prose: [docs/testing.md](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/testing.md) — section "E2E with dev/prod and PE parity" (and "Running a subset locally")
