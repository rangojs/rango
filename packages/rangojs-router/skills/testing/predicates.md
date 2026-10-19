# Testing navigation predicates — runTransitionWhen, runRevalidate

**Layer:** unit (node) · **Import:** `@rangojs/router/testing` · **DSL it tests:** `transition({ when })` (see `/view-transitions`) and `revalidate()` in `urls()` and in `clientUrls()` (see `/client-urls`)

Both primitives run the router's own evaluation code on arguments you seed, so a predicate sees the same fields it sees at runtime. Neither renders anything: they answer "would this navigation hold?" and "would this loader re-run?". `runTransitionWhen` is synchronous; `runRevalidate` returns a Promise. A `transition({ when })` predicate runs in the browser at runtime; a `revalidate()` predicate runs on the server, a `clientUrls()` loader's included (the build moves it there).

## runTransitionWhen(when | config, opts?)

Builds the `TransitionWhenContext` the browser builds and evaluates the predicate through the router's own browser code (`browser/transition-when.ts`): a throw counts as `false` and is logged with `console.error`, exactly as at navigation time. Accepts the predicate or a whole `transition()` config (a config without `when` always applies).

### Options — `RunTransitionWhenOptions`

Every field is optional. A location (`from` / `to`) is a URL string, a `URL`, or a partial `RouteLocation`: `{ url?, params?, routeName?, state? }`. A `state` given as location-state entries (`[Def(value)]`, what `Link` and `router.push` take) is stored the way a push stores it, so `Def.read(ctx.to)` reads it back; any other value is used as the raw `history.state`.

| Field    | Type                                                              | Meaning                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`   | `"push" \| "replace" \| "pop" \| "action" \| "revalidate"`        | Defaults to `"action"` when `action` is given, `"push"` otherwise.                                                                                                      |
| `from`   | location                                                          | The committed location being left. Defaults to `http://localhost/`.                                                                                                     |
| `to`     | location                                                          | The destination. Defaults to `from`; always `from` for `"action"` and `"revalidate"`.                                                                                   |
| `action` | imported action \| `string` \| `{ ref, formData, result, error }` | The triggering action (`isAction()` matches it; `action.id` is its id). Like `runRevalidate`, an imported action outside a built app needs its id passed as the string. |

### Returns — `RunTransitionWhenResult`

| Field      | Type                    | Meaning                                                                                                               |
| ---------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `applied`  | `boolean`               | True when the navigation holds: the predicate returned anything but `false` and did not throw, or there is no `when`. |
| `gatedOff` | `boolean`               | `!applied`: the navigation commits urgently with no view transition.                                                  |
| `context`  | `TransitionWhenContext` | The context the predicate received.                                                                                   |

### Recipe

```ts
import { it, expect } from "vitest";
import {
  runTransitionWhen,
  withLocationStateKey,
} from "@rangojs/router/testing";
import { slideWhen } from "../src/transitions.js"; // a "use client" module
import { Slide } from "../src/location-states.js";

withLocationStateKey(Slide, "Slide");

it("animates unless the Link pushed { animate: false }", () => {
  expect(
    runTransitionWhen(slideWhen, {
      from: { url: "/photos/1", params: { id: "1" }, routeName: "photo" },
      to: { url: "/photos/2", params: { id: "2" }, routeName: "photo" },
    }).applied,
  ).toBe(true);

  const { gatedOff, context } = runTransitionWhen(slideWhen, {
    from: "/photos/1",
    to: { url: "/photos/2", state: [Slide({ animate: false })] },
  });
  expect(Slide.read(context.to)).toEqual({ animate: false });
  expect(gatedOff).toBe(true);
});
```

### Known limits (Vitest)

- A Vitest project runs neither the Vite plugin's hoist nor its validation. An inline `when` in a `urls()` file stays a plain function there, and a `"use client"` import is the plain function outside the RSC graph, so a server function is not told apart and is accepted. The loud error for an invalid `when` belongs to dev startup, the build and HMR.
- `renderRoute` decides each commit with production's decision code: `router.navigate()` (and `useRouter().push/replace`, `<Link>`) as `kind: "push"` / `"replace"`, `router.refresh()` as `kind: "revalidate"`, and `navigate(url, { transition: false })` without calling the predicate. Pop, action and `clientUrls()` optimistic-swap decisions are e2e territory.

## runRevalidate(fn | fn[], opts?)

Evaluates one `revalidate()` predicate, or a chain in declaration order, through the router's production `evaluateRevalidation` inside a seeded request context. It serves `urls()` and `clientUrls()` predicates alike: a `clientUrls()` loader's predicate runs on the server with the `urls()` arguments, so the argument object (`currentParams`, `currentUrl`, `nextParams`, `nextUrl`, `defaultShouldRevalidate`, `context`, `segmentType`, `actionId`, `isAction`, `actionUrl`, `actionResult`, `formData`, `method`, `routeName`/`fromRouteName`/`toRouteName`, `stale`) is the production one. Returns `Promise<boolean>`: the final decision (true re-runs the segment). The locked default, boolean short-circuit and soft verdicts are the production code paths. A throwing predicate fails open to the default (logged with `console.error`); a thrown `Response` is rethrown.

### Options — `RunRevalidateOptions`

Defaults model a same-URL navigation with no action, for a route-owned loader: a predicate that defers resolves `false`, and with an `action` it resolves `true`.

| Field            | Type                                                            | Meaning                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currentUrl`     | `string \| URL`                                                 | The page being left. Defaults to `http://localhost/`.                                                                                                                                                                       |
| `nextUrl`        | `string \| URL`                                                 | The destination. Defaults to `currentUrl`.                                                                                                                                                                                  |
| `currentParams`  | `Record<string, string>`                                        | Source params. Defaults to `{}`.                                                                                                                                                                                            |
| `nextParams`     | `Record<string, string>`                                        | Target params. Defaults to `currentParams`.                                                                                                                                                                                 |
| `action`         | imported action \| `string` \| `{ ref, result, formData, url }` | The triggering action. `ref` is an imported server action (its id is read from `$id ?? $$id`) or an action id string; `result` is `actionResult`, `formData` is `formData`, `url` is `actionUrl`. Makes the request a POST. |
| `method`         | `string`                                                        | Overrides the request method (`POST` with an `action`, otherwise `GET`).                                                                                                                                                    |
| `segmentType`    | `"layout" \| "route" \| "parallel" \| "loader"`                 | The segment type the predicate is attached to. Defaults to `"loader"`.                                                                                                                                                      |
| `belongsToRoute` | `boolean`                                                       | Defaults to `true`; `false` models a layout's loader, which a navigation keeps by default.                                                                                                                                  |
| `stale`          | `boolean`                                                       | The `stale` arg (a navigation during a server action's flight, or a history entry's background revalidation). Defaults to `false`.                                                                                          |
| `routeName`      | `string`                                                        | `toRouteName` (and `routeName`).                                                                                                                                                                                            |
| `fromRouteName`  | `string`                                                        | `fromRouteName`.                                                                                                                                                                                                            |
| `env`            | `TEnv`                                                          | Environment bindings of the seeded context.                                                                                                                                                                                 |
| `vars`           | `VarsInit`                                                      | Variables a middleware would have set, readable with `context.get()`.                                                                                                                                                       |
| `context`        | the predicate's `context`                                       | Replaces the seeded context.                                                                                                                                                                                                |

Outside a built app, an imported action carries no `$id`: pass the id string your predicate matches (for example `"src/actions/cart.ts#addToCart"`), or stamp `$id` on the imported function in the test (`Object.assign(addToCart, { $id: "src/actions/cart.ts#addToCart" })`); `runRevalidate` throws a clear error otherwise.

### Recipe

The build moves a `clientUrls()` predicate to the server and accepts only imports and globals in it, so keep a predicate you want to test in its own module without `"use client"` and import it both in the group and here. Vitest does not run the plugin, so there the predicate is a plain function. To run it through the real handler instead, mount the group in the Flight project with `rangoUseClientTransform()` wired, and send a `serveShellRequest` navigation or `action` request ([`./serve-shell-request.md`](./serve-shell-request.md)).

```ts
// src/predicates.ts — no "use client"
import type { ShouldRevalidateFn } from "@rangojs/router";
import { checkout } from "./actions/cart.js";

export const onTabChange: ShouldRevalidateFn = ({ currentUrl, nextUrl }) =>
  currentUrl.searchParams.get("tab") !== nextUrl.searchParams.get("tab");

export const onCheckoutOk: ShouldRevalidateFn = (ctx) =>
  ctx.isAction(checkout) ? ctx.actionResult?.ok === true : undefined;
```

```ts
import { it, expect } from "vitest";
import { runRevalidate } from "@rangojs/router/testing";
import { checkout } from "../src/actions/cart.js";
import { onTabChange, onCheckoutOk } from "../src/predicates.js";

// The build stamps a "use server" export with its id; Vitest does not.
Object.assign(checkout, { $id: "src/actions/cart.ts#checkout" });

it("revalidates only when the tab changes", async () => {
  expect(
    await runRevalidate(onTabChange, {
      currentUrl: "/settings?tab=profile",
      nextUrl: "/settings?tab=billing",
    }),
  ).toBe(true);
  expect(
    await runRevalidate(onTabChange, {
      currentUrl: "/settings?tab=profile",
      nextUrl: "/settings?tab=profile&sort=asc",
    }),
  ).toBe(false);
});

it("re-runs after checkout only when it succeeded", async () => {
  expect(
    await runRevalidate(onCheckoutOk, {
      action: { ref: checkout, result: { ok: true } },
    }),
  ).toBe(true);
  expect(
    await runRevalidate(onCheckoutOk, {
      action: { ref: checkout, result: { ok: false } },
    }),
  ).toBe(false);
});
```

## Caveats

- `runRevalidate` proves the predicate's decision, not the build: the hoist's rules (imports and globals only, no browser globals) are checked by the Vite plugin at dev startup and build, not in Vitest. Assert the post-action result of a real group at e2e.
- `runTransitionWhen` proves the decision only. Whether the browser actually runs a view transition is e2e territory (see `./e2e-parity.md`).
- `runTransitionWhen` is synchronous. `runRevalidate` returns a Promise because it awaits the router's `evaluateRevalidation`, but a predicate itself must be synchronous: one returning a Promise is a bug in the predicate (the router keeps the default and warns in development), and the `clientUrls()` build rejects an `async` one.

## See also

- `/view-transitions`, `/client-urls` — the DSL these test
- Siblings: `./client-components.md`, `./e2e-parity.md`
