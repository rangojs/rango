# Testing a handle — collectHandle, plus the loader read/write and client read paths

**Layer:** unit (node + DOM) · **Import:** `@rangojs/router/testing` (collectHandle), `@rangojs/router/testing/dom` (renderRoute) · **DSL it tests:** a handle e.g. Breadcrumbs/Meta (see `/handler-use`, `/breadcrumbs`)

A handle's `collect`/accumulator (the `createHandle(collect)` argument that maps per-segment pushed values into one accumulated result) is otherwise unreachable — `createHandle` keeps it in a private registry keyed by `$$id`. These primitives test it from different angles: `collectHandle` runs the REAL registered collect on per-segment values you SEED; `runLoader` seeds the POST-collect accumulated value a loader READS (`ctx.get(handle)` after the barrier); `runLoaderResult(...).handlePushes` records what a loader WRITES (`ctx.use(SomeHandle)({...})`, in push order); `renderRoute` seeds the RAW pushed values for a client component reading `useHandle`. None of them run the real push -> accumulate -> barrier wiring (that stays e2e).

## API

### `collectHandle(handle, segments)` — `src/testing/collect-handle.ts`

| Param      | Type                                  | Meaning                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handle`   | `Handle<TData, TAccumulated>`         | The handle whose registered collect to run.                                                                                                                                                                                                          |
| `segments` | `ReadonlyArray<ReadonlyArray<TData>>` | Per-segment pushed values, one inner array per route segment, in **parent -> child** order. Empty inner arrays are filtered before the collect runs (matching production `collectHandleData` — a segment that pushed nothing is not passed through). |

**Returns** `TAccumulated` — exactly what the handle's collect produces (the default identity collect's per-segment `TData[][]`, or a custom accumulator's value). If the handle's module was never imported (collect unregistered), it falls back to that same identity default and **warns** — a handle with a custom collect that failed to register would otherwise return the wrong shape silently.

### runLoader option — `handles` — `src/testing/run-loader.ts`

| Field      | Type                                        | Meaning                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `handles`  | `ReadonlyArray<readonly [Handle, unknown]>` | Seeds the value `ctx.get(SomeHandle)` returns — the POST-collect **ACCUMULATED** value (singular `unknown`), what a loader reads after `await ctx.rendered()`. Matched by handle reference. Pair with `rendered`.                                                        |
| `rendered` | `boolean \| (() => void \| Promise<void>)`  | Mocks the `ctx.rendered()` barrier (throws by default). `true` resolves it immediately; a function controls timing/side effects. A `ctx.get(handle)` read before the barrier settles throws, exactly as in production. (`ctx.use(handle)` — the WRITE — is never gated.) |

### renderRoute option — `handles` — `src/testing/render-route.tsx`

| Field     | Type                                          | Meaning                                                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handles` | `ReadonlyArray<readonly [Handle, unknown[]]>` | Seeds the CLIENT read path for `useHandle(handle)` — the RAW **pushed values array** (`unknown[]`), the values a route's handlers would have pushed. Attached to the leaf route segment under the handle's `$$id`, so `useHandle` runs the handle's REAL collect on them. |

**Shape contrast:** `renderRoute` feeds the barrier INPUT (the pushes, `unknown[]`); `runLoader` feeds its OUTPUT (the single accumulated value, `unknown`).

**Across navigation:** seeded `handles` are applied once at the initial render and PERSIST across `router.navigate()` within the same test (like `loaderData`) — unlike a real navigation, which re-runs handlers. A layout/page reading `useHandle` still resolves the seeded values after `navigate()`.

## Recipe

```ts
// collectHandle.test.ts — the pure collect, no route match
import { describe, it, expect } from "vitest";
import { collectHandle } from "@rangojs/router/testing";
import { createHandle } from "@rangojs/router";

// Opt into a flat list; the default collect groups per segment (TData[][]).
type Crumb = { label: string; href: string };
const Breadcrumbs = createHandle<Crumb, Crumb[]>((segments) => segments.flat());

it("flattens per-segment crumbs in parent->child order", () => {
  const home = { label: "Home", href: "/" };
  const post = { label: "P", href: "/p" };
  expect(collectHandle(Breadcrumbs, [[home], [post]])).toEqual([home, post]);
});

it("runs a custom 'last wins' collect", () => {
  const PageTitle = createHandle<string, string>((s) => s.flat().at(-1) ?? "");
  expect(collectHandle(PageTitle, [["Home"], ["Products"], ["Shoes"]])).toBe(
    "Shoes",
  );
});
```

```ts
// loader-reads-handle.test.ts — a loader reading accumulated handle data after the barrier
import { it, expect } from "vitest";
import { runLoader } from "@rangojs/router/testing";
import { RenderedProducts } from "../src/handles"; // a createHandle(...)

const livePricesBody = async (ctx) => {
  await ctx.rendered(); // barrier: handle data is now readable
  const ids = ctx.get(RenderedProducts) as string[];
  return ids.map((id) => ({ id, price: 9.99 }));
};

it("reads the accumulated handle value (seed the OUTPUT, mock the barrier)", async () => {
  const data = await runLoader(livePricesBody, {
    rendered: true,
    handles: [[RenderedProducts, ["widget-a", "widget-b"]]], // singular accumulated value
  });
  expect(data).toEqual([
    { id: "widget-a", price: 9.99 },
    { id: "widget-b", price: 9.99 },
  ]);
});
```

```ts
// loader-writes-handle.test.ts — a loader PUSHING meta/breadcrumbs (handler parity)
import { it, expect } from "vitest";
import { runLoaderResult } from "@rangojs/router/testing";
import { Meta } from "../src/handles";

const productBody = async (ctx) => {
  const product = { name: "Widget", slug: "widget" };
  ctx.use(Meta)({ title: `${product.name} — Shop` });
  return product;
};

it("records loader handle writes in push order", async () => {
  const { result, handlePushes } = await runLoaderResult(productBody);
  expect(result?.name).toBe("Widget");
  expect(handlePushes).toEqual([
    { handle: Meta, value: { title: "Widget — Shop" } },
  ]);
});
```

```tsx
// breadcrumb-trail.test.tsx — a client component reading useHandle
// @vitest-environment happy-dom
import { it, expect, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { useHandle } from "@rangojs/router/client";
import { Breadcrumbs } from "../src/handles";

afterEach(cleanup);

function BreadcrumbTrail() {
  const crumbs = useHandle(Breadcrumbs); // accumulated client-side via the real collect
  return <nav>{crumbs.map((c) => c.label).join(" / ")}</nav>;
}

it("renders the seeded trail (seed the INPUT pushes, the collect runs)", async () => {
  const { getByText } = await renderRoute(
    [{ path: "/p", Component: BreadcrumbTrail }],
    {
      handles: [
        [
          Breadcrumbs,
          [
            { label: "Home", href: "/" },
            { label: "P", href: "/p" },
          ],
        ],
      ], // raw pushes array
    },
  );
  expect(getByText("Home / P")).toBeTruthy();
});
```

## Caveats

- `collectHandle` tests the pure collect/accumulator in ISOLATION (parent -> child segment order, empty arrays filtered to match production). It does NOT run the real push -> accumulate -> barrier wiring — that stays e2e.
- renderRoute `handles` seeds the CLIENT read path with the RAW pushed values array (`unknown[]`), attached to the leaf segment. Handle data accumulates GLOBALLY (not segment-scoped like loaders), so a LAYOUT reading the same handle sees the seeded values too, not just the leaf route.
- runLoader `handles` seeds the POST-collect ACCUMULATED value (singular `unknown`) a loader reads via `ctx.get(handle)` after `await ctx.rendered()`; pair with `{ rendered: true }`. Shape contrast: renderRoute feeds the barrier INPUT (pushes[]), runLoader feeds its OUTPUT (the accumulated value).
- Loader WRITES are the other direction: `ctx.use(SomeHandle)({...})` records into `runLoaderResult(...).handlePushes` (push order; a `.defer()` resolver's value is recorded when the resolver runs). Nothing to seed — assert the envelope.
- The renderRoute path is the CLIENT tree only: it does NOT catch server/client boundary remount bugs, real Flight serialization errors, or loader execution.

## See also

- `/handler-use`, `/breadcrumbs` — the DSL this tests
- Siblings: `./loader.md`, `./client-components.md`, `./render-handler.md`
- Long-form prose: [docs/testing.md](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/testing.md) — section "Testing a handle's collect/accumulator"
