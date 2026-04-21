---
name: streams-and-websockets
description: Long-lived Response handlers — Server-Sent Events (SSE) via path.stream and WebSocket upgrades via path.any on Cloudflare Workers, including middleware interaction and runtime caveats.
argument-hint: "[sse | websocket | agents]"
---

# Streams and WebSockets

Response routes can return long-lived responses — SSE streams and WebSocket
upgrades. Both require a `Response` that the router must forward through the
middleware chain without reconstruction.

## When each fits

| Shape       | Tag             | Status | Body                            | Runtime                          |
| ----------- | --------------- | ------ | ------------------------------- | -------------------------------- |
| Server-Sent | `path.stream()` | 200    | `ReadableStream` (event-stream) | any runtime (Node, workerd, bun) |
| WebSocket   | `path.any()`    | 101    | `null` + `webSocket` property   | Cloudflare Workers (workerd)     |

- **SSE** is a regular 200 response with `content-type: text/event-stream`
  and a `ReadableStream` body. Works everywhere, flows through middleware
  normally.
- **WebSocket upgrades** produce a status-101 response with a non-standard
  `webSocket` property (Cloudflare). The router detects these and forwards
  them without reconstruction; `Vary` and `Server-Timing` are skipped, and
  stub headers are merged in place on a best-effort basis.

## Server-Sent Events (SSE)

Use `path.stream()` (or `path.any()` if you need full control) to return a
`ReadableStream`. Each chunk is an `event-stream` frame:

```typescript
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path }) => [
  path.stream(
    "/events/ticks",
    (ctx) => {
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          let count = 0;
          const interval = setInterval(() => {
            controller.enqueue(
              encoder.encode(`event: tick\ndata: ${++count}\n\n`),
            );
          }, 1000);

          // Honor client disconnect — signal comes from ctx.request.signal
          ctx.request.signal.addEventListener("abort", () => {
            clearInterval(interval);
            controller.close();
          });
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          // Disable proxy buffering on Nginx/Traefik deployments
          "x-accel-buffering": "no",
        },
      });
    },
    { name: "ticks" },
  ),
]);
```

### Client

```typescript
"use client";
const source = new EventSource("/events/ticks");
source.addEventListener("tick", (e) => console.log("tick", e.data));
```

### SSE caveats

- **Never wrap SSE routes in `cache()`** — a cached `ReadableStream` is read
  once and would replay an empty body on the next hit. `path.stream` is
  already excluded from response-route caching, but don't layer a custom
  cache() middleware on top.
- **Middleware is fine.** Global/route middleware rewraps the SSE `Response`
  as `new Response(response.body, { status, headers })` to merge stub headers.
  The `ReadableStream` body is passed by reference, not consumed, so the
  client sees the stream unchanged. (WebSocket upgrades are the exception —
  those bypass rewrap entirely; see below.)
- **Honor `ctx.request.signal`.** Without wiring abort to your source
  (timer, DB cursor, upstream fetch), the stream leaks when the client
  disconnects.
- **Disable Nginx/CDN buffering** via `x-accel-buffering: no` and ensure
  no intermediate proxy rebuffers. On Cloudflare Workers this is a non-issue.

## WebSockets (Cloudflare Workers)

WebSocket upgrades on workerd produce a response with `status: 101` and a
non-standard `webSocket` property. The router detects this shape and forwards
the `Response` without reconstruction — the 101 status and the `webSocket`
property are preserved. `Vary` and `Server-Timing` writes are skipped, and
stub-header merging (cookies/custom headers set via `ctx.header()` or
`cookies().set()`) is best-effort: the router attempts to apply them in
place, but silently skips any write rejected by a runtime that exposes
immutable upgrade headers.

### Minimal upgrade handler

```typescript
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path }) => [
  path.any(
    "/ws",
    (ctx) => {
      // Manual WebSocketPair on workerd
      const upgrade = ctx.request.headers.get("upgrade");
      if (upgrade !== "websocket") {
        return new Response("expected upgrade: websocket", { status: 426 });
      }

      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      server.addEventListener("message", (e) => {
        server.send(`echo: ${e.data}`);
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      } as ResponseInit);
    },
    { name: "ws" },
  ),
]);
```

### Durable Object pattern

Route into a Durable Object that owns the connection:

```typescript
export const urlpatterns = urls(({ path }) => [
  path.any(
    "/rooms/:roomId",
    async (ctx) => {
      const id = ctx.env.ROOMS.idFromName(ctx.params.roomId);
      const stub = ctx.env.ROOMS.get(id);
      // The DO's fetch handler calls handleWebSocketUpgrade(request)
      // and returns the 101 Response. We forward it unchanged.
      return stub.fetch(ctx.request);
    },
    { name: "room" },
  ),
]);
```

### Using the `agents` library

`routeAgentRequest` from `agents` returns a 101 `Response` targeted at a
Durable Object. Return it directly from `path.any()`:

```typescript
import { routeAgentRequest } from "agents";
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path }) => [
  path.any("/agents/*", async (ctx) => {
    const response = await routeAgentRequest(ctx.request, ctx.env);
    if (!response) {
      return new Response("not found", { status: 404 });
    }
    return response;
  }),
]);
```

## Middleware interaction

### Forwarded, not reconstructed

When a middleware is matched for the upgrade URL, the middleware still runs
**before** `next()` — but the Response from `next()` is forwarded as-is
rather than re-wrapped. This preserves:

- The 101 status (which would otherwise throw `RangeError: Responses may
only be constructed with status codes in the range 200 to 599, inclusive`
  on standards-compliant runtimes).
- The Cloudflare `webSocket` property (which would otherwise be silently
  dropped by `new Response(body, ...)` on workerd).

```typescript
// This works — logger runs, but the 101 flows through unchanged.
router.use(async (ctx, next) => {
  console.log("ws request", ctx.url.pathname);
  return next();
});
```

### Don't try to set cookies on an upgrade

Stub cookie/header writes made before `await next()` are applied to the
upgrade response on a best-effort basis — the router attempts an in-place
merge and skips any write rejected by runtimes that expose immutable 101
headers. Either way, a browser completing a WS handshake never reads them.
Do not rely on this for auth or state propagation: set cookies via a prior
HTTP request instead (e.g. during login), then read them at upgrade time
via `ctx.request.headers.get("cookie")`.

```typescript
// Avoid: this cookie may not land on the upgrade response, and the client
// never reads it during the handshake regardless.
router.use(async (ctx, next) => {
  cookies().set("last-ws-at", Date.now().toString());
  return next();
});

// Prefer: authenticate by reading a cookie set on a prior HTTP request.
path.any("/ws", (ctx) => {
  const session = parseCookie(ctx.request.headers.get("cookie"))?.session;
  if (!verify(session)) return new Response("unauthorized", { status: 401 });
  // ...upgrade
});
```

### Short-circuit before upgrade

Middleware can return a non-101 Response to deny the upgrade outright:

```typescript
router.use(async (ctx, next) => {
  if (!isAllowed(ctx.request)) {
    return new Response("forbidden", { status: 403 });
  }
  return next();
});
```

## Caching

- **SSE** — do not combine with `cache()` (streams can't be replayed).
- **WebSocket** — `cache()` is inert because only `status === 200` is cacheable.

## Runtime caveats

| Runtime                                | SSE | WebSocket upgrade (101)                              |
| -------------------------------------- | --- | ---------------------------------------------------- |
| Cloudflare Workers (workerd)           | OK  | OK (native `WebSocketPair`, DO, `agents`)            |
| Node (undici fetch)                    | OK  | N/A — Node's HTTP server must upgrade                |
| Bun                                    | OK  | Bun's native `upgrade()` — not a Response-based path |
| Dev (Vite + `@cloudflare/vite-plugin`) | OK  | OK via workerd emulation                             |

When running in pure Node without workerd, a `status: 101` Response cannot
even be constructed (`new Response(null, { status: 101 })` throws). For
tests, fabricate upgrade-style responses by overriding `.status` on a real
Response instance:

```typescript
const upgrade = new Response(null, { status: 200 });
Object.defineProperty(upgrade, "status", { value: 101, configurable: true });
// optional: attach a webSocket stub
Object.defineProperty(upgrade, "webSocket", {
  value: { stub: "ws" },
  configurable: true,
  enumerable: true,
});
```

## Testing

- Unit tests: `isWebSocketUpgradeResponse` and `executeMiddleware` passthrough
  cases live in `src/rsc/__tests__/helpers.test.ts` and
  `src/router/middleware.test.ts`.
- E2E: cover both dev and production modes against a workerd target. SSE
  can be tested on any runtime; WS upgrades need workerd (use
  `@cloudflare/vite-plugin` or `wrangler dev`).

## See also

- `response-routes` — the parent skill for `path.json/text/html/stream/any`.
- `middleware` — how global and route-level middleware compose with handlers.
