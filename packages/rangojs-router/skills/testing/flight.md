# Testing an async Server Component — renderToFlightString

**Layer:** RSC unit (react-server project) · **Import:** `@rangojs/router/testing/flight` + `@rangojs/router/testing/flight-matchers` · **DSL it tests:** an async Server Component / Flight output (see `/route`)

`renderToFlightString` runs the REAL react-server-dom serializer the router uses at runtime — your async Server Component genuinely renders to its Flight wire string in plain node, with a request context active for the render. What you SEED is the request, headers, env, params, routeName, and vars that context exposes.

## API

### Options — `RenderToFlightStringOptions`

| Field       | Type                     | Meaning                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`   | `Request \| string`      | The request the render runs under: a `Request`, or a URL string (absolute or path). Defaults to `http://localhost/`. A component reading `getRequestContext()` sees this request's url/cookies. When a `Request` is passed, its headers are used and `headers` is ignored. |
| `headers`   | `HeadersInit`            | Request headers (e.g. Cookie) visible to the server tree, used only when `request` is a string.                                                                                                                                                                            |
| `env`       | `unknown`                | Env / bindings exposed as `ctx.env`. Defaults to `{}`.                                                                                                                                                                                                                     |
| `params`    | `Record<string, string>` | Route params exposed via `ctx.params` and loader contexts.                                                                                                                                                                                                                 |
| `routeName` | `string`                 | Matched route name (drives `ctx.routeName` and scoped reverse).                                                                                                                                                                                                            |
| `vars`      | `VarsInit`               | Variables a prior middleware would have set, visible via `ctx.get(...)`. Object form (`{ user }`) or `[key, value]` tuples (`[[userVar, u]]`).                                                                                                                             |

### Context — `RequestContext` (what your component receives)

A request context is active for the whole render, so an async Server Component can read it via `getRequestContext()` / the router's server APIs. The notable surfaces seeded from the options above:

| Field       | Type                                      | Meaning                                                               |
| ----------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `request`   | `Request`                                 | The backing request (from `request`/`headers`).                       |
| `url`       | `URL`                                     | The request URL.                                                      |
| `env`       | `unknown`                                 | Env / bindings (from `env`).                                          |
| `params`    | `Record<string, string>`                  | Route params (from `params`).                                         |
| `routeName` | `string \| undefined`                     | Matched route name (from `routeName`).                                |
| `get`       | `<T>(v: ContextVar<T>) => T \| undefined` | Read a var seeded via `vars` (by `createVar()` handle or string key). |
| `cookies`   | reader                                    | Cookies parsed from the request's Cookie header.                      |

### Returns — `Promise<string>`

The Flight wire string for the rendered tree. Assert on it with the matchers (register via `expect.extend(flightMatchers)`):

```ts
expect(await renderToFlightString(<C />)).toMatchFlight("substring"); // containment
expect(await renderToFlightString(<C />)).toMatchFlightSnapshot();     // normalized snapshot
```

`toMatchFlight(substring)` is containment (not equality) on the normalized payload; `toMatchFlightSnapshot()` snapshots the normalized payload. Both matchers live at `@rangojs/router/testing/flight-matchers` and run ONLY under the react-server vitest project (see `./setup.md`).

## Recipe

Name the file `*.rsc-test.{ts,tsx}` and run `pnpm test:unit:rsc`:

```tsx
import { it, expect } from "vitest";
import { renderToFlightString } from "@rangojs/router/testing/flight";
import { flightMatchers } from "@rangojs/router/testing/flight-matchers";
expect.extend(flightMatchers);

// Pure leaf server components: data comes in as props, not getRequestContext.
async function Greeting({ name }: { name: string }) {
  const who = await Promise.resolve(name);
  return <h1>Hello {who}</h1>;
}

async function ItemView({ id }: { id: string }) {
  const item = await Promise.resolve({ id, label: `Item ${id}` });
  return <article>{item.label}</article>;
}

it("renders an async server component to Flight", async () => {
  const flight = await renderToFlightString(<Greeting name="Ada" />);
  expect(flight).toMatchFlight("Ada");
});

it("snapshots the normalized payload", async () => {
  const flight = await renderToFlightString(<ItemView id="7" />);
  expect(flight).toMatchFlightSnapshot();
});
```

## Caveats

- Leaf / server-only: a client island in the tree emits an un-hydratable `I[...]` import row against the empty client manifest. Keep Flight tests to leaf server components; test full pages at e2e.
- Requires the react-server vitest project (see `./setup.md`): `resolve.conditions` includes `react-server`, the `@rangojs/router -> index.rsc.ts` alias, `NODE_ENV=production`, and the worker `execArgv`. Name files `*.rsc-test.{ts,tsx}` and run `pnpm test:unit:rsc`. The main vitest project must NOT set `react-server` (it would flip React to the no-hooks server build).
- A component that imports a server API (`getRequestContext`, `cookies`) from the bare `@rangojs/router` barrel works ONLY with the `index.rsc.ts` alias wired (see `./setup.md`); without it the bare import resolves to the throwing out-of-react-server stub. Pure-leaf components that take all data as props need no barrel import and are the simplest case.
- `toMatchFlight` is containment (substring), not equality — the row framing (prefixes/quoting) is an internal serializer detail, so pin the rendered text/shape, not the framing. `toMatchFlightSnapshot()` snapshots the normalized payload; run under `NODE_ENV=production` for the cleanest, most stable bytes.
- No hydration / no interaction here — that is the e2e tier. For typed assertions on a client boundary's props (a `Date` back as a `Date`), or to confirm an island actually crossed the boundary, use `renderServerTree` (see `./server-tree.md`).

## See also

- `/route` — the DSL this tests
- Siblings: `./setup.md`, `./server-tree.md`, `./render-handler.md`
- Long-form prose: [docs/testing.md](https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/testing.md) — section "renderToFlightString — real async Server Components"
