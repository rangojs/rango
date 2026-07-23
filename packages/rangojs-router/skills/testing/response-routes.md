# Testing a response route / redirect — dispatch

**Layer:** integration (node) · **Import:** `@rangojs/router/testing` · **DSL it tests:** response routes (json/text/html/xml/md), redirects, 404 (see `/response-routes`, `/mime-routes`)

`dispatch` runs the router's REAL matching (reusing `previewMatch`) and the real global + route-level middleware chain, with no RSC render — so redirects, 404s, response routes, content negotiation, and middleware short-circuits behave exactly as in production. You SEED the request and `env`; everything else (matching, middleware, header/cookie merge) is real machinery.

## API

### Options — `DispatchOptions<TEnv>`

| Field                | Type                | Meaning                                                                            |
| -------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `request` (required) | `Request \| string` | The request to dispatch: a `Request`, or a URL string (absolute or path).          |
| `env`                | `TEnv`              | Environment bindings forwarded to matching and middleware (surfaced as `ctx.env`). |

### Context — response-handler `ctx` (what your code receives)

The lightweight context a RESPONSE-route handler reads (mirrors the production `handleResponseRoute` shape). Notable fields:

| Field                 | Type                     | Meaning                                                                                                     |
| --------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `request`             | `Request`                | The dispatched request.                                                                                     |
| `params`              | `Record<string, string>` | URL params from the matched route.                                                                          |
| `env`                 | `TEnv`                   | Bindings from `opts.env`.                                                                                   |
| `searchParams`        | `URLSearchParams`        | Query params with internal `_rsc*` params stripped.                                                         |
| `url`                 | `URL`                    | Cleaned request URL (internal `_rsc*` params removed).                                                      |
| `pathname`            | `string`                 | Matched pathname.                                                                                           |
| `reverse`             | `ReverseFunction`        | URL-from-name. Map-only (NO auto-fill from current params), matching the production response-route handler. |
| `get`                 | fn                       | Read context vars set by prior middleware.                                                                  |
| `header(name, value)` | fn                       | Set a response header; surfaces on the returned `Response`.                                                 |
| `waitUntil`           | fn                       | Register a deferred task (no-op fidelity in tests).                                                         |

### Returns — `dispatch(router, opts) -> Promise<Response>`

```ts
function dispatch<TEnv = any>(
  router: Rango<TEnv, any>,
  opts: DispatchOptions<TEnv>,
): Promise<Response>;
```

A real `Response`: response-route body, a 308 redirect (`Location`), a 404, or a middleware short-circuit. A `path.json` handler that returns a bare value is serialized verbatim (no envelope); a returned or thrown `Response` uses the same control-flow path; cookies and `ctx.header(...)` surface on the `Response`. `dispatch` accepts your public router type directly (no cast).

## Recipe

```ts
import { describe, it, expect } from "vitest";
import { dispatch } from "@rangojs/router/testing";
import { createRouter } from "@rangojs/router";
import { apiPatterns } from "../src/api/urls"; // path.json(...) routes, no Prerender

const router = createRouter().routes(apiPatterns);

describe("api routes via dispatch", () => {
  it("serializes a JSON response route as the bare handler value", async () => {
    const res = await dispatch(router, { request: "/health" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json;charset=utf-8",
    );
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("maps a thrown RouterError to its status + RFC 9457 problem+json", async () => {
    const res = await dispatch(router, { request: "/products/999" }); // handler throws RouterError 404
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(
      "application/problem+json;charset=utf-8",
    );
    expect((await res.json()).code).toBe("NOT_FOUND"); // { title, status, detail, code }
  });

  it("returns 404 for an unmatched path", async () => {
    expect((await dispatch(router, { request: "/nope" })).status).toBe(404);
  });
});
```

`dispatch` also covers trailing-slash/redirect targets (`findMatch`) — a redirected path returns a 308 with the `Location` (query preserved). Pass `env` via `{ env }`.

## Caveats

- Hitting a COMPONENT (RSC) route throws a clear directive error: `dispatch` is for response routes + redirects + 404 + content negotiation, plus the global + route-level middleware guard stack on RESPONSE routes — it never renders React. Use Flight primitives or e2e to exercise component rendering.
- A COMPONENT route's guard stack cannot run here. Assert it at e2e, or extract the middleware fn and unit-test it with `runMiddleware` (see `./middleware.md`).
- JSON serialization is bare, applied in `response-route-handler.ts`: a `path.json` handler that returns a value is serialized verbatim (`JSON.stringify(value)`, status 200, `application/json`) — no envelope. Returning or throwing a `Response` (e.g. `Response.json(x)`) uses the same control-flow path. Any other thrown error yields an RFC 9457 problem+json body `{ title, status, detail, code }` (`application/problem+json`) with the error's status (`RouterError.status`, else 500, or a non-200 `ctx.res.status` already set upstream in the request pipeline); `code` is the `RouterError.code`, else `"INTERNAL"`. The `type` member is omitted this phase. Assert the shape matching what your handler returns.
- Setup: needs the preset (alias + virtual stubs) or a Vite-RSC env (see `./setup.md`); a bare router import throws on Vite virtuals.
- A router using `Prerender()`/`createLoader()`/`Static()` now constructs in a bare test (each assigns a runtime fallback `$$id`). Importing the whole router _file_ may still need the plugin (its page modules pull app deps / `virtual:` modules) — build from a focused include (your API routes) for whole-router dispatch.
- A `_rsc_partial` request to a response route runs global middleware first (an auth gate can still 401/redirect), then returns `X-RSC-Reload` — route-level middleware is skipped, exactly like production.
- `dispatch` does NOT execute server actions (`?_rsc_action`), but it DOES run the global middleware chain on an action request — middleware can still 401/redirect it, and any 3xx redirect on a partial OR action request becomes a `204` + `X-RSC-Redirect` (fetch-safe interception), the raw `Location` dropped.

## See also

- `/response-routes`, `/mime-routes` — the DSL this tests
- Siblings: `./middleware.md`, `./setup.md`, `./cache-prerender.md`
- Long-form prose: [docs/testing.md](https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/testing.md) — section "dispatch — request to Response" (the `rangoTestConfig` preset stubs `@vitejs/plugin-rsc/rsc`, so no per-file `vi.mock` is needed)
