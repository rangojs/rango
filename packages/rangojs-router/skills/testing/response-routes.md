# Testing a response route / redirect — dispatch

**Layer:** integration (node) · **Import:** `@rangojs/router/testing` · **DSL it tests:** response routes (json/text/html/xml/md), redirects, 404 (see `/response-routes`, `/mime-routes`)

`dispatch` runs the production handler's REAL request stages — classify (matching + content negotiation), the terminal plans (reloads, the rewritten-action rule), and the real global + route-level middleware chain — with no RSC render, so redirects, 404s, reloads, response routes, content negotiation, and middleware short-circuits behave exactly as in production. You SEED the request and `env`; everything else (matching, middleware, header/cookie merge) is real machinery.

Matching goes through the route trie, as every request in `vite dev` and production does.

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
| `reverse`             | `GlobalReverseFunction`  | Global names only (NO auto-fill, `.name` is a type error), matching the production response-route handlers. |
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

`dispatch` also covers, with production code paths:

- trailing-slash redirects from the trie — a route with `trailingSlash: "never"` or `"always"` answers the other form with a 308 and the `Location` (query preserved). A route with no `trailingSlash` serves its URL with and without a trailing slash, with no redirect, as production does;
- the open-redirect guard on browser-followed redirects (a cross-origin `Location` is rewritten to the basename root unless `redirect(url, { external: true })`);
- content-negotiated routes whose winning route is a response route (`Vary: Accept` appended);
- the reloads production answers inside the global middleware chain: a request whose `_rsc_v` names another deploy's document version (`setBuildVersions`, `./serve-shell-request.md`), and a `_rsc_partial` request whose `_rsc_rid` names another router (a cross-app navigation), get an `X-RSC-Reload` at the visitor's URL — on any route, a component route or an unmatched path included;
- cached response routes (`cache({ ... })` around a `path.json` etc.): hit, SWR, and tag writes. The cache write is scheduled via `waitUntil` (a microtask in tests), so flush microtasks between the seeding `dispatch` and the one that asserts the hit;
- `createRouter({ telemetry })` `request.start` / `request.end` / `request.error` events, all with one `requestId`, which a response route's `request.timeout` carries too (a rewritten pass's included), and `createRouter({ onError })` for cache-read/write failures.

## Caveats

- Hitting a COMPONENT (RSC) route throws a clear directive error: `dispatch` is for response routes + redirects + 404 + negotiation won by a response route, plus the global + route-level middleware guard stack on RESPONSE routes — it never renders React. Use Flight primitives or e2e to exercise component rendering.
- On a content-negotiated URL, any `Accept` the page route wins throws the same error. Serve that request with `serveShellRequest(router, url, { headers: { accept } })` (`./serve-shell-request.md`): it runs the production handler and answers the HTML document or the Flight stream, with `Vary: Accept`.
- A COMPONENT route's guard stack cannot run here. Assert it at e2e, or extract the middleware fn and unit-test it with `runMiddleware` (see `./middleware.md`).
- JSON serialization is bare, applied in `response-route-handler.ts`: a `path.json` handler that returns a value is serialized verbatim (`JSON.stringify(value)`, status 200, `application/json`) — no envelope. Returning or throwing a `Response` (e.g. `Response.json(x)`) uses the same control-flow path. Any other thrown error takes the error's status (`RouterError.status`, else 500, or a non-200 status already set upstream in the request pipeline). On a `path.json` route the body is an RFC 9457 problem+json object `{ title, status, detail, code }` (`application/problem+json;charset=utf-8`), where `code` is the `RouterError.code`, else `"INTERNAL"`, and the `type` member is omitted. On text/html/xml/md routes the body is `text/plain`: the `RouterError` message, the error message in dev, or `"Internal Server Error"` in production. Assert the shape matching what your handler returns.
- Setup: needs the preset (alias + virtual stubs) or a Vite-RSC env (see `./setup.md`); a bare router import throws on Vite virtuals.
- Building the trie runs route discovery: every `include()`d `urls()` handler runs once more, and every async include provider (`() => import(...)`) is called. Count provider calls or handler runs after the first `dispatch` on that router, not from router construction. A provider that rejects fails the `dispatch`, as it fails `vite dev` and the build.
- A router using `Prerender()`/`createLoader()`/`Static()` now constructs in a bare test (each assigns a runtime fallback `$$id`). Importing the whole router _file_ may still need the plugin (its page modules pull app deps / `virtual:` modules) — build from a focused include (your API routes) for whole-router dispatch.
- A `throw rewrite(target)` from global or route middleware re-dispatches as the router does: global middleware matched on the target's path, the target's route middleware and handler, the same request context, `x-rango-rewrite` on the response, 508 on a loop. The visitor's URL is matched before middleware runs, so it must be a response route (or a redirect or 404) too; a rewrite target that is a component route throws the same error as a direct request. An action request (`?_rsc_action`) a rewrite moves to a response route, a redirect or an unmatched path rejects with production's error, `A rewrite of a server action or form post must target a page route; …`.
- The route's params and name are set inside the global middleware chain, as production sets them: a global middleware reads `ctx.routeName` (and `getRequestContext().params`) after `await next()`, not before it. A trailing-slash redirect sets none.
- A `_rsc_partial` request to a response route runs global middleware first (an auth gate can still 401/redirect), then returns `X-RSC-Reload` — route-level middleware is skipped, exactly like production.
- `dispatch` does NOT execute server actions (`?_rsc_action`), but it DOES run the global middleware chain on an action request — middleware can still 401/redirect it. When a global middleware matches the path, any 3xx that leaves the chain on a partial OR action request (a global or route middleware's redirect, a response route's, a trailing-slash redirect) becomes a `204` + `X-RSC-Redirect` (fetch-safe interception), the raw `Location` dropped. Without one, an action request's 3xx goes out raw (through the open-redirect guard), as production sends it; a trailing-slash redirect on a partial request is a `204` either way. Location state carried on such a redirect is dropped too (production embeds it in a Flight payload); cover that at e2e.
- `createRouter({ onError })` is NOT invoked for a thrown non-Response HANDLER error here (the typed error Response still matches production), and `cache.decision` / `loader.*` telemetry never fires (no RSC render runs). Cover both at e2e.

## See also

- `/response-routes`, `/mime-routes` — the DSL this tests
- Siblings: `./middleware.md`, `./setup.md`, `./cache-prerender.md`
- Long-form prose: [docs/testing.md](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/testing.md) — section "dispatch — request to Response" (the `rangoTestConfig` preset stubs `@vitejs/plugin-rsc/rsc`, so no per-file `vi.mock` is needed)
