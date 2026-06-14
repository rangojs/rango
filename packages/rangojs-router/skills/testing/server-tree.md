# Inspecting the rendered tree — renderServerTree, findClientBoundaries, findElements

**Layer:** RSC unit (react-server project) · **Import:** `@rangojs/router/testing/flight` · **DSL it tests:** client islands across the boundary + server-rendered host content (see `/route`)

`renderServerTree` is the DEFAULT way to assert on a Flight render; `renderToFlightString` (see [`./flight.md`](./flight.md)) is the escape hatch for pinning the raw wire bytes. It serializes the real Flight (identical bytes to `renderToFlightString`) and then deserializes it back to an inspectable React element tree you traverse — that serialize/deserialize round-trip is REAL; what you SEED is the element you render plus the request context (`request`/`headers`/`params`/`vars`/`env`). The win over the wire string: a client boundary's props come back as real JS values (a `Date` is a `Date`, not the opaque `$D...` encoding) and you can confirm a `"use client"` component actually crossed the boundary (an `I` row) instead of being inlined. There is NO hydration and NO interaction — boundaries are inert placeholders carrying props.

## API

### Options — `RenderServerTreeOptions` (extends `RenderToFlightStringOptions`)

| Field              | Type                      | Meaning                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`          | `Request \| string`       | The request the render runs under (absolute URL, path, or a `Request`). Defaults to `http://localhost/`. A server component reading `getRequestContext()` sees this url/cookies. A passed `Request`'s headers win; `headers` is then ignored.                                                                                          |
| `headers`          | `HeadersInit`             | Request headers (e.g. `Cookie`) visible to the server tree, when `request` is a string.                                                                                                                                                                                                                                                |
| `env`              | `unknown`                 | Env / bindings exposed as `ctx.env`. Defaults to `{}`.                                                                                                                                                                                                                                                                                 |
| `params`           | `Record<string, string>`  | Route params exposed via `ctx.params` and loader contexts.                                                                                                                                                                                                                                                                             |
| `routeName`        | `string`                  | Matched route name (drives `ctx.routeName` and scoped reverse).                                                                                                                                                                                                                                                                        |
| `vars`             | `VarsInit`                | Context variables visible via `ctx.get(...)`, as a prior middleware would have set them. Object form (`{ user }`) or `[key, value]` tuples.                                                                                                                                                                                            |
| `clientComponents` | `Record<string, unknown>` | The `"use client"` components reachable from the tree, keyed by the boundary name to register each as a client reference (in place) so it serializes as an `I` row. Omit when `rangoUseClientTransform()` auto-discovers them, or for pure server-only trees. First-wins per worker; already-registered references are left untouched. |

### Context — what your code receives

A server component rendered here runs under a real request context: `getRequestContext()` resolves, `ctx.params`/`ctx.routeName`/`ctx.env` reflect the options, `ctx.get(MyVar)` reads a seeded `var`, and cookies come off the request. Same seeding as the handler-test primitives — you render an **element** you build (`<Page />`); to run a route **handler** `(ctx) => rsc` use `renderHandler` (see `./render-handler.md`).

### Returns — `RenderServerTreeResult`

```ts
renderServerTree(element, opts?): Promise<{ flight: string; tree: unknown }>
```

| Field    | Type      | Meaning                                                                                                                                                                                                  |
| -------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flight` | `string`  | The raw Flight wire string (so `toMatchFlight` assertions still apply).                                                                                                                                  |
| `tree`   | `unknown` | The deserialized React element tree. Server elements are plain React elements; each client boundary is an inert placeholder whose `props` are the real deserialized JS values that crossed the boundary. |

#### `findClientBoundaries(tree, selector?) -> ClientBoundary[]`

Every client boundary in document order; always an array (no throw on zero/many — destructure `const [tag] = ...` and assert `.length` when the count matters; no match yields `[]`). `selector` is a STRING (match by export name) or a `BoundarySelector` object, criteria AND-ed.

| `BoundarySelector` | Type                                    | Meaning                                                                                    |
| ------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `name`             | `string`                                | Match the boundary's export name (same as a bare string).                                  |
| `testId`           | `string`                                | Match `props["data-testid"]` exactly (a `data-testid` you passed AS A PROP to the island). |
| `props`            | `Record<string, unknown>`               | Subset deep-equal match (Date/Map/Set/array/nested-object aware); unlisted props ignored.  |
| `where`            | `(boundary: ClientBoundary) => boolean` | Arbitrary predicate.                                                                       |

`ClientBoundary` = `{ id, name, props (excludes children), children, element }`.

#### `findElements(tree, selector?) -> FoundElement[]`

Every SERVER/HOST element a server component produced (`<article>`, `<h2>`), in document order; always an array. `selector` is a host TAG string (`"h2"`) or an `ElementSelector` object, criteria AND-ed.

| `ElementSelector` | Type                                 | Meaning                                                                            |
| ----------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| `tag`             | `string`                             | Match the host tag name (`"article"`, `"h2"`).                                     |
| `testId`          | `string`                             | Match `props["data-testid"]` exactly (on a host element).                          |
| `props`           | `Record<string, unknown>`            | Subset deep-equal match (Date/Map/Set/array/nested aware).                         |
| `text`            | `string \| RegExp`                   | Match the element's text content (substring for a string, `.test()` for a RegExp). |
| `where`           | `(element: FoundElement) => boolean` | Arbitrary predicate.                                                               |

`FoundElement` = `{ tag, props (excludes children), children, text, element }`.

#### `textContent(node) -> string`

Concatenates every string/number leaf of a node's subtree in document order — the clean way to assert rendered text, instead of `JSON.stringify(tree).toContain(...)`.

## Recipe

```tsx
import { it, expect } from "vitest";
import {
  renderServerTree,
  findClientBoundaries,
  findElements,
  textContent,
} from "@rangojs/router/testing/flight";
import { PriceTag } from "./PriceTag.js"; // a "use client" component (any filename)

async function ProductPanel({ amount, asOf }: { amount: number; asOf: Date }) {
  await Promise.resolve();
  return (
    <article>
      <h2>Wine</h2>
      <PriceTag amount={amount} currency="USD" asOf={asOf} />
    </article>
  );
}

it("client props survive the serialize -> deserialize round trip", async () => {
  const { flight, tree } = await renderServerTree(
    <ProductPanel amount={19.5} asOf={new Date("2026-01-02T00:00:00Z")} />,
    // Omit clientComponents when rangoUseClientTransform() is wired (see ./setup.md);
    // otherwise register islands explicitly:
    { clientComponents: { PriceTag } },
  );
  expect(flight).toMatchFlight("PriceTag"); // wire assertions still work

  const [tag] = findClientBoundaries(tree, "PriceTag");
  expect(tag.props.amount).toBe(19.5); // a real number
  expect(tag.props.asOf).toBeInstanceOf(Date); // a real Date, not "$D..."
});

it("asserts the server-rendered host content", async () => {
  const { tree } = await renderServerTree(
    <ProductPanel amount={19.5} asOf={new Date("2026-01-02T00:00:00Z")} />,
    { clientComponents: { PriceTag } },
  );
  const [h2] = findElements(tree, "h2");
  expect(h2.text).toBe("Wine");
  expect(textContent(tree)).toContain("Wine"); // instead of JSON.stringify(tree)
});
```

## Caveats

- This renders an ELEMENT you build (`<Page />`). To test a route HANDLER (a `(ctx) => rsc` function registered via `path(...)`), use `renderHandler` (see [`./render-handler.md`](./render-handler.md)) — handlers have their own util. Do NOT wrap a handler in `createElement` and render it here: a handler is not a component, so React would invoke it with `props` as its argument instead of the real `HandlerContext`, and the seeded `params`/`vars` plus `ctx.use`/`ctx.reverse`/`ctx.get`/`cookies()` would all be absent.
- Island auto-discovery from the server tree's imports needs `rangoUseClientTransform()` in the rsc project (see `./setup.md`). Without it a plainly-imported island is just a function the serializer renders server-side — register islands explicitly via `{ clientComponents: { PriceTag } }`.
- Same alias requirement as `./flight.md`: a rendered component (or handler) that reads `getRequestContext()`/`cookies()` from the `@rangojs/router` barrel needs the `index.rsc.ts` alias (see `./setup.md`), or it hits the throwing out-of-react-server stub.
- A client boundary's props come back as REAL JS values after deserialization (a `Date` is a `Date`, not a `$D...` encoding) — but there is NO hydration and NO interaction; boundaries are inert placeholders carrying props.
- Server COMPONENTS do not survive Flight as identities (they are executed during serialization), so `findElements` matches the host elements they PRODUCED, not the component function. Client islands keep identity — use `findClientBoundaries` for those.
- `findClientBoundaries` finds islands (`I` rows); `findElements` finds host elements. A `testId` on an island matches with `findClientBoundaries`; a `testId` on a host element matches with `findElements`. Use `textContent(node)` in place of `JSON.stringify(tree).toContain`.
- A true interactive, clickable DOM `renderServer` is intentionally NOT shipped: in-process happy-dom hydration re-tests React more than your app and misses server/client divergence (the only hydration bug worth a dedicated test, which needs a real browser). Test interaction at e2e.

## See also

- `/route` — the DSL this tests
- Siblings: `./flight.md`, `./render-handler.md`, `./setup.md`
- Long-form prose: [docs/testing.md](https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/testing.md) — section "renderServerTree — serialize then deserialize to an inspectable tree" (and the "findElements / textContent" subsection)
