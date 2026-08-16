# Testing reverse/href and type-level contracts

**Layer:** unit (node) + typecheck · **Import:** `@rangojs/router/client` (useReverse), `@rangojs/router/testing` (assertGeneratedRoutesMatch) · **DSL it tests:** `reverse`/`href`/`useReverse` (see `/typesafety`, `/links`)

The reverse/href/params/env types are a real contract: a wrong route name, a missing param, or an unknown env binding should be a COMPILE error, not a runtime surprise. The type-test recipes have no runtime API — `tsc --noEmit` IS the assertion. `assertGeneratedRoutesMatch` is the one runtime helper here: it runs the router's real matching to expand lazy includes, then diffs the live `routeMap` against the generated named-routes map you seed. It (and `diffGeneratedRoutes`) are **async — `await` them** — because expanding an async `include(prefix, () => import("./routes"))` group means importing that module first.

## API

### Options — `assertGeneratedRoutesMatch(router, generatedMap?)`

| Field          | Type                                 | Meaning                                                                                                                                                    |
| -------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `router`       | `{ routeMap; findMatch? }`           | Your router (real impl). `routeMap` is the live name→pattern map; `findMatch` (when present) is called to force-expand lazy `include()`d routes.           |
| `generatedMap` | `Record<string, unknown>` (optional) | The imported `*.named-routes.gen.ts` map (name→pattern, or `{ path }` objects). Omit to diff against the global route map (`getGlobalRouteMap()`) instead. |

### Context — `GeneratedRoutesDiff` (what `diffGeneratedRoutes` resolves to)

| Field      | Type                           | Meaning                                                                                                                                     |
| ---------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing`  | `string[]`                     | Names in the generated map but absent at runtime (stale generated entry).                                                                   |
| `extra`    | `string[]`                     | Names at runtime but absent from the generated map (ungenerated route). Auto-generated internal names (`$path_*`/`$prefix_*`) are excluded. |
| `mismatch` | `[name, generated, runtime][]` | Names in both whose patterns differ.                                                                                                        |
| `ok`       | `boolean`                      | True when `missing`, `extra`, and `mismatch` are all empty.                                                                                 |

### Returns — `assertGeneratedRoutesMatch`

`Promise<void>` — **await it**. Resolves on match; on drift the promise REJECTS with an `Error` listing every missing, extra, and mismatched route plus a "regenerate the `*.named-routes.gen.ts` file" hint. (`diffGeneratedRoutes` resolves to the `GeneratedRoutesDiff` above and never rejects.) Both are async so an async `include(() => import())` group is imported and spliced into `routeMap` before the diff — call them without `await` and every route in that group reads as a false `missing`.

## Recipe

```ts
// 1. Negative assertions inline with @ts-expect-error — the directive ERRORS if
//    the line below it ever starts compiling (i.e. if the type guard regresses).
//    Validated by `tsc --noEmit`; a runtime test cannot assert this.
import { useReverse } from "@rangojs/router/client";

const reverse = useReverse({ post: "/blog/:slug" });
reverse("post", { slug: "hi" }); // ok
// @ts-expect-error - missing required :slug param
reverse("post", {});
// @ts-expect-error - "comment" is not a route in this map
reverse("comment", { id: "1" });
```

```ts
// 2. Positive assertions with vitest's expectTypeOf — pin an INFERRED type
//    (loader return, parsed search schema, RouteParams) inside a normal *.test.ts.
import { expectTypeOf } from "vitest";
import type { RouteParams } from "@rangojs/router";

// RouteParams takes a route NAME and a route map (defaulting to the global map).
// Pass an explicit map to keep the type test self-contained.
expectTypeOf<
  RouteParams<"blogPost", { blogPost: "/blog/:slug" }>
>().toEqualTypeOf<{ slug: string }>();
```

```ts
// 3. assertGeneratedRoutesMatch — a one-liner whole-app drift test. Real
//    matching expands lazy include()d routes before the diff. It is async
//    (it awaits findMatch to import async include groups), so await it.
import { it } from "vitest";
import { assertGeneratedRoutesMatch } from "@rangojs/router/testing";
import { router } from "../src/router";
import generated from "../src/router.named-routes.gen";

it("generated named-routes map is in sync with the router", async () => {
  await assertGeneratedRoutesMatch(router, generated);
});
```

For a large type-only suite, collect recipe-1/2 assertions in `*.test-d.ts` files and add a `tsconfig.types.json` that `extends` your base config and `include`s only those files, then run `tsc -p tsconfig.types.json --noEmit` in CI. This is how the repo pins its own augmentation contracts. Recipe 1 is enough for most apps; reach for the dedicated tsconfig only when inline assertions clutter runtime tests.

## Caveats

- Type tests run at TYPECHECK time (`tsc --noEmit`), NOT in the vitest runner. They are their own layer — wire them into CI as a real step (`pnpm run typecheck`). A type test nobody runs is just a comment.
- `@ts-expect-error` ERRORS if the line below it ever starts compiling, so a regressed guard fails the typecheck. A runtime test cannot assert "this should not type-check".
- `assertGeneratedRoutesMatch` force-expands lazy `include()`d routes (awaits `findMatch` on a concrete path derived from each generated pattern) before diffing — otherwise every included route reads as a false `missing`. It is **async** so it can await the module import behind an async `include(() => import())` group; `await` the call (or the async group's routes read as `missing`). This makes the whole-app drift check work in a plain unit test. Routers without `findMatch` (a bare `{ routeMap }`) are left as-is.
- MULTI-APP route-map isolation. `href()`/`reverse()` typing is GLOBAL — each app's generated file augments the one `Rango.GeneratedRouteMap` interface. A `renderRoute` suite that imports a client component from app B (which calls `href("/b-route")`) won't typecheck if the same tsconfig program also carries app A's augmentation: A's route union rejects B's name. `renderRoute` is app-agnostic at RUNTIME; the collision is purely the global `href` typing. Keep a `renderRoute` suite single-app, or give each app its OWN tsconfig program (see `/typesafety`); a quick sidestep is to probe `useMount`/`useHref` inline instead of importing the cross-app component.

## See also

- `/typesafety`, `/links` — the DSL this tests
- Siblings: `./client-components.md`, `./loader.md`
- Long-form prose: [docs/testing.md](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/testing.md) — section "Type-level tests — make misuse fail to compile"
