# Testing navigation predicates — runTransitionWhen, runClientRevalidate

**Layer:** unit (node) · **Import:** `@rangojs/router/testing` · **DSL it tests:** `transition({ when })` (see `/view-transitions`) and `clientUrls()` `revalidate()` (see `/client-urls`)

Both primitives are synchronous and run the router's own evaluation code on arguments you seed, so a predicate sees the same fields it sees at runtime. Neither renders anything: they answer "would this navigation hold?" and "would this `clientUrls()` loader re-run?". Both predicates run in the browser at runtime.

## runTransitionWhen(when | config, opts?)

Builds the `TransitionWhenContext` the browser builds and evaluates the predicate through the router's own browser code (`browser/transition-when.ts`): a throw counts as `false` and is logged with `console.error`, exactly as at navigation time. Accepts the predicate or a whole `transition()` config (a config without `when` always applies).

### Options — `RunTransitionWhenOptions`

Every field is optional. A location (`from` / `to`) is a URL string, a `URL`, or a partial `RouteLocation`: `{ url?, params?, routeName?, state? }`. A `state` given as location-state entries (`[Def(value)]`, what `Link` and `router.push` take) is stored the way a push stores it, so `Def.read(ctx.to)` reads it back; any other value is used as the raw `history.state`.

| Field    | Type                                                              | Meaning                                                                                                                                                                       |
| -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`   | `"push" \| "replace" \| "pop" \| "action" \| "revalidate"`        | Defaults to `"action"` when `action` is given, `"push"` otherwise.                                                                                                            |
| `from`   | location                                                          | The committed location being left. Defaults to `http://localhost/`.                                                                                                           |
| `to`     | location                                                          | The destination. Defaults to `from`; always `from` for `"action"` and `"revalidate"`.                                                                                         |
| `action` | imported action \| `string` \| `{ ref, formData, result, error }` | The triggering action (`isAction()` matches it; `action.id` is its id). Like `runClientRevalidate`, an imported action outside a built app needs its id passed as the string. |

### Returns — `RunTransitionWhenResult`

| Field      | Type                    | Meaning                                                                              |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `applied`  | `boolean`               | True when the navigation holds (the predicate returned true, or there is no `when`). |
| `gatedOff` | `boolean`               | `!applied`: the navigation commits urgently with no view transition.                 |
| `context`  | `TransitionWhenContext` | The context the predicate received.                                                  |

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

## runClientRevalidate(fn | fn[], opts?)

Evaluates one `clientUrls()` loader `revalidate()` predicate, or a chain in declaration order, through the production chain evaluator: the locked default, boolean short-circuit, soft verdicts (`{ defaultShouldRevalidate }`), and a throwing predicate deferring to the default all behave as in the browser. Returns the final `boolean` (the locked default when every predicate defers or throws).

### Options — `RunClientRevalidateOptions`

Defaults model a same-URL navigation with no action.

| Field           | Type                             | Meaning                                                                                                                                                                                         |
| --------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currentUrl`    | `string \| URL`                  | Source URL. Defaults to `http://localhost/`.                                                                                                                                                    |
| `nextUrl`       | `string \| URL`                  | Target URL. Defaults to `currentUrl`.                                                                                                                                                           |
| `currentParams` | `Record<string, string>`         | Source params. Defaults to `{}`.                                                                                                                                                                |
| `nextParams`    | `Record<string, string>`         | Target params. Defaults to `currentParams`.                                                                                                                                                     |
| `stale`         | `boolean`                        | The `stale` arg. Defaults to `false`.                                                                                                                                                           |
| `action`        | `(...args) => unknown \| string` | The triggering action: one imported server action (its id is read from the build-injected `$id`/`$$id`) or a raw action id string. A namespace object is rejected. Omit for a plain navigation. |
| `actionRequest` | `boolean`                        | Model the action-triggered refetch GET: `isAction()` stays true but the locked default is the navigation default. Defaults to treating `action` as the action POST itself.                      |

Outside a built app, an imported action carries no id, so pass the id string your predicate matches (for example `"src/actions/cart.ts#addToCart"`); `runClientRevalidate` throws a clear error otherwise.

### Recipe

```ts
import { it, expect } from "vitest";
import { runClientRevalidate } from "@rangojs/router/testing";
import type { ClientRevalidateFn } from "@rangojs/router/client";

const onlyOnTabChange: ClientRevalidateFn = ({ currentUrl, nextUrl }) =>
  currentUrl.searchParams.get("tab") !== nextUrl.searchParams.get("tab");

it("revalidates only when the tab changes", () => {
  expect(
    runClientRevalidate(onlyOnTabChange, {
      currentUrl: "/settings?tab=profile",
      nextUrl: "/settings?tab=billing",
    }),
  ).toBe(true);
  expect(
    runClientRevalidate(onlyOnTabChange, {
      currentUrl: "/settings?tab=profile",
      nextUrl: "/settings?tab=profile&sort=asc",
    }),
  ).toBe(false);
});
```

## Caveats

- Server-tree `revalidate()` predicates have no dedicated primitive: they are plain functions, so call them with a hand-built args object, or assert the post-action result at e2e.
- `runTransitionWhen` proves the decision only. Whether the browser actually runs a view transition is e2e territory (see `./e2e-parity.md`).
- Both are synchronous; a predicate returning a Promise is a bug in the predicate, not something to await here.

## See also

- `/view-transitions`, `/client-urls` — the DSL these test
- Siblings: `./client-components.md`, `./e2e-parity.md`
