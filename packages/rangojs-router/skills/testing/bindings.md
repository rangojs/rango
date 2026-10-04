# Testing platform bindings — your double is the seam

**Layer:** cross-cutting (unit/integration) · **Seam:** the `env` option every primitive takes

The node primitives test the router's seams; the moment your loader/middleware/action calls a **platform binding** (`env.DB`, a Durable Object stub, `env.R2`), you have crossed out of rango and into your app's I/O. The router machinery is real — what you seed is the binding double behind it, injected through `env`.

## Where it plugs in

rango ships **no doubles** for platform bindings — they are app- and schema-specific. You build the double and inject it through the `env` option that every primitive already accepts:

- `runLoader(body, { env })`
- `runMiddleware(fn, { request, env })`
- `runInRequestContext(fn, { request, env })`
- `renderHandler(handler, { request, env })`
- `dispatch(router, { request, env })`
- `renderToFlightString(el, { env })`

Inside the run, `getRequestContext().env` (and anything that reads it — `cache()`, your loaders, your middleware) sees the object you passed.

## Driver contract

The work here is matching the binding's **driver contract**, not its public API. A double that satisfies the public surface but not the driver's wire shape mounts green and proves nothing.

- **Per-method shapes.** `drizzle-orm/d1` serves SELECTs through `.raw()` and writes (INSERT/UPDATE/DELETE) through `.run()`. The two return different shapes and hit different code paths in the decoder. Model **both**.
- **`.raw()` (reads).** Must serve **positional row arrays in schema-column order**, with the driver-level encodings so the decoder round-trips `Date`/JSON. NOT `{ column: value }` objects.
- **`.run()` (writes).** Returns `{ success, meta }` — no rows — and bypasses the row responder entirely.

## Recipe

```ts
import { describe, it, expect } from "vitest";
import {
  runLoader,
  runMiddleware,
  runInRequestContext,
} from "@rangojs/router/testing";
import { bundleLoaderBody } from "../app/loaders";
import { requireMembership } from "../app/middleware";
import { authorizeAction } from "../app/actions";

// A D1Database double satisfying drizzle-orm/d1's driver contract.
// rango ships no double for D1 — build your own to match the driver.
const fakeD1 = {
  prepare: () => ({
    // .raw() serves positional rows in schema-column order, driver-encoded.
    raw: async () => [[1, "acme", "2026-01-01T00:00:00.000Z"]],
    // .run() returns { success, meta }, no rows.
    run: async () => ({ success: true, meta: { changes: 1 } }),
    all: async () => ({ results: [], success: true, meta: {} }),
    first: async () => null,
    bind: (..._args: unknown[]) => ({
      raw: async () => [[1, "acme", "2026-01-01T00:00:00.000Z"]],
      run: async () => ({ success: true, meta: { changes: 1 } }),
      all: async () => ({ results: [], success: true, meta: {} }),
      first: async () => null,
    }),
  }),
  batch: async (stmts: unknown[]) =>
    stmts.map(() => ({ results: [], success: true, meta: {} })),
  exec: async (_sql: string) => ({ count: 0, duration: 0 }),
};

describe("bindings seam", () => {
  it("loader reads through env.DB", async () => {
    const result = await runLoader(bundleLoaderBody, { env: { DB: fakeD1 } });
    expect(result).toMatchObject({ slug: "acme" });
  });

  it("middleware reads through env.DB", async () => {
    const { nextCalled, response } = await runMiddleware(requireMembership, {
      request: "/t/acme/edit",
      env: { DB: fakeD1 },
    });
    expect(nextCalled).toBe(1); // membership passed, chain continued
    expect(response.status).toBe(200);
  });

  it("action reads through env.DB", async () => {
    const { result } = await runInRequestContext(
      () => authorizeAction({ id: 1 }),
      {
        env: { DB: fakeD1 },
        request: "/t/acme/edit",
      },
    );
    expect(result).toBe(true);
  });
});
```

## Caveats

- rango ships **no doubles** for platform bindings (`env.DB`, Durable Objects, `env.R2`) by design — they are app- and schema-specific. Inject your own double through the `env` option every primitive takes.
- This is usually the **single biggest effort** in a consumer unit suite, and the work is matching the **driver contract**, not the binding's public API.
- `drizzle-orm/d1`: a `D1Database` double must serve **positional row arrays in schema-column order** for drizzle's `.raw()` path (with driver-level encodings so the decoder round-trips `Date`/JSON), NOT `{ column: value }` objects — an object-shaped double returns silently-wrong or empty rows.
- The contract is **per-method**: SELECTs go through `.raw()` (positional rows); writes (INSERT/UPDATE/DELETE) go through `.run()`, which returns `{ success, meta }` (no rows) and bypasses the row responder entirely. Model **both** paths — a read-only `.raw()` double silently no-ops every write.
- Keep the double at the **binding boundary**; never mock a rango primitive to dodge building it.

## See also

- (cross-cutting)
- Siblings: `./loader.md`, `./middleware.md`, `./server-actions.md`
- Long-form prose: [docs/testing.md](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/testing.md) — section "What these primitives deliberately don't cover (the platform-bindings paragraph)"
