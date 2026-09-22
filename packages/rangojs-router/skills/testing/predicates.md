# Testing navigation predicates — runTransitionWhen, runClientRevalidate

**Layer:** unit (node) · **Import:** `@rangojs/router/testing` · **DSL it tests:** `transition({ when })` (see `/view-transitions`) and `clientUrls()` `revalidate()` (see `/client-urls`)

Both primitives are synchronous and run the router's own evaluation code on arguments you seed, so a predicate sees the same fields it sees at runtime. Neither renders anything: they answer "would this gate keep the transition?" and "would this `clientUrls()` loader re-run?".

## runTransitionWhen(config, opts?)

Runs a `transition()` config through the production gate (`gateTransitions`, plus the PPR pre-handler evaluator when `ppr: true`) and reports whether the transition survives this request.

### Options — `RunTransitionWhenOptions<TEnv>`

Every field is optional. Omitted navigation fields model "source unavailable" (an initial document load); omitted `action*` fields model a plain navigation.

| Field           | Type                     | Meaning                                                                                           |
| --------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `request`       | `Request \| string`      | Navigation TARGET (drives `nextUrl`). Defaults to `http://localhost/`.                            |
| `params`        | `Record<string, string>` | Target params (`nextParams`).                                                                     |
| `toRouteName`   | `string`                 | Target route name (`toRouteName`).                                                                |
| `currentUrl`    | `string \| URL`          | Navigation SOURCE (`currentUrl`).                                                                 |
| `currentParams` | `Record<string, string>` | Source params (`currentParams`).                                                                  |
| `fromRouteName` | `string`                 | Source route name (`fromRouteName`).                                                              |
| `actionId`      | `string`                 | Id of the action that triggered the render.                                                       |
| `actionUrl`     | `string \| URL`          | URL the action was submitted from.                                                                |
| `actionResult`  | `unknown`                | The action's return value.                                                                        |
| `formData`      | `FormData`               | Form data from a form action.                                                                     |
| `env`           | `TEnv`                   | Bindings surfaced as `env`.                                                                       |
| `vars`          | `VarsInit`               | Values the predicate reads through `get()`. With `ppr`, these model pre-handler middleware state. |
| `onError`       | `OnErrorCallback`        | Receives an error the predicate throws (the gate reports it with phase `"rendering"`).            |
| `ppr`           | `boolean`                | Model a `ppr` route, where the predicate runs before route handlers and the cache lookup.         |

### Returns — `RunTransitionWhenResult<TEnv>`

| Field         | Type                                 | Meaning                                                                                         |
| ------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `kept`        | `boolean`                            | True when the transition applies (the predicate did not return `false`, or there is no `when`). |
| `dropped`     | `boolean`                            | `!kept`.                                                                                        |
| `whenContext` | `TransitionWhenContext \| undefined` | The context the predicate received; `undefined` when the config has no `when`.                  |
| `ctx`         | `RequestContext<TEnv>`               | The underlying request context, for extra assertions.                                           |

### Recipe

```ts
import { it, expect } from "vitest";
import { runTransitionWhen } from "@rangojs/router/testing";
import type { TransitionConfig } from "@rangojs/router";

const slide: TransitionConfig = {
  when: (c) => c.fromRouteName === "products",
};

it("animates only when coming from the product list", () => {
  expect(
    runTransitionWhen(slide, {
      request: "/products/1",
      fromRouteName: "products",
    }).kept,
  ).toBe(true);
  expect(runTransitionWhen(slide, { request: "/products/1" }).dropped).toBe(
    true,
  );
});
```

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
- `runTransitionWhen` proves the GATE decision only. Whether the browser actually runs a view transition is e2e territory (see `./e2e-parity.md`).
- Both are synchronous; a predicate returning a Promise is a bug in the predicate, not something to await here.

## See also

- `/view-transitions`, `/client-urls` — the DSL these test
- Siblings: `./client-components.md`, `./e2e-parity.md`
