# Cloudflare Workers: Streaming, Dev Tooling, and Deploy

## 10. Cloudflare Workers: streaming, dev tooling, and deploy

This is the part of an RR7-on-Cloudflare migration that the API tables above do
**not** cover, and it produces symptoms that look like router bugs but aren't.
RR7 serves a fully-rendered HTML/Turbo-Stream response; Rango serves a **streamed**
RSC/SSR response. Anything in the request path that was harmless for RR7 but
**buffers the response** silently kills that stream — the `loading()` /
`<Suspense>` fallback never shows and the page appears "awaited" (old content
held until everything resolves).

### 10a. Never buffer the Rango response in a custom worker entry

RR7 Cloudflare entries commonly **rewrite the response body** — `await
response.text()` / `await response.arrayBuffer()`, `HTMLRewriter`, cookie/URL
rewriting, hybrid-proxy bridging. That is fine for RR7's complete HTML, but if it
runs on the **Rango** path it consumes the stream and you lose streaming
entirely.

Rule: in the worker entry, the Rango response must pass through as a **stream**.
Buffer only on non-Rango branches (a legacy/SFRA proxy, an error page).

```typescript
// BAD — buffers the whole RSC stream before returning (no streaming, no fallback)
const response = await router.fetch(request, { env, ctx });
const body = await response.text(); // <- drains the stream
return new Response(rewrite(body), response);

// GOOD — pass the body through as a stream (re-wrap headers only)
const response = await router.fetch(request, { env, ctx });
return new Response(response.body, response); // <- streams; safe to add headers
```

If you keep a legacy proxy (e.g. an SFRA/host fallback) that legitimately buffers
to rewrite HTML, gate it so it only runs for proxied paths — never for the
`router.fetch()` result.

Keep the custom entry itself (host/site resolution, sessions, proxy fallback) —
that's real product logic, not a deviation. Just don't let it touch the stream.

### 10b. Use `vite dev` / `vite preview`, not `wrangler dev`, for local work

The `@cloudflare/vite-plugin` runs **your worker entry** inside miniflare for both
`vite dev` and `vite preview`, with bindings + `.dev.vars`, and it **streams**.
`wrangler dev` does **not** stream RSC locally: it gzip-compresses the response by
buffering the entire body before sending. Measured on a bare streaming Worker
under `wrangler dev`: `Accept-Encoding: gzip` → first byte at the full delay
(buffered); `Accept-Encoding: identity` → first byte at ~3ms (streams). The
deployed Cloudflare edge does **streaming** compression, so this is a
**local-`wrangler dev`-only artifact** — do not mistake it for a production
streaming bug (verify the deployed edge with `curl` and watch chunk timing /
`transfer-encoding: chunked`).

```jsonc
// package.json — the standard rango-on-Workers shape
"dev":     "vite",          // streams, bindings, .dev.vars live
"build":   "vite build",
"preview": "vite preview",  // runs the built worker in workerd; also streams
// wrangler is only for: wrangler deploy / wrangler secret
```

If a workflow truly requires `wrangler dev`, declare `Content-Encoding: identity`
on streamed responses, gated to local hostnames (so the edge still compresses):

```typescript
if (
  isLocalHostname(url.hostname) &&
  response.body &&
  !response.headers.has("content-encoding")
) {
  const ct = (response.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("text/x-component")) {
    const headers = new Headers(response.headers);
    headers.set("content-encoding", "identity"); // wrangler skips gzip -> streams
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
```

### 10c. `.dev.vars` loads differently per tool

A frequent "my env vars vanished after migration" symptom — it's the tool, not
the file:

| Command        | How `.dev.vars` is loaded                                                            |
| -------------- | ------------------------------------------------------------------------------------ |
| `wrangler dev` | Loaded natively at runtime (RR7's path — why it "worked before")                     |
| `vite dev`     | Loaded **live** by the plugin (+ `.dev.vars.<CLOUDFLARE_ENV>` if a named env is set) |
| `vite preview` | Read from the **build output** `dist/<env>/.dev.vars`, written at `vite build` time  |

So `vite preview` only sees vars that were present when you built — re-run
`vite build` after editing `.dev.vars`. (`vite dev` is the simplest: live vars +
streaming, no rebuild.)

### 10d. Build output moves from `build/` to `dist/`

RR7's `react-router build` writes to `build/`; Rango's `vite build` writes to
`dist/` (`dist/client`, `dist/rsc`, …). The leftover `build/` paths in
`wrangler.toml` and cleanup scripts must move, or you deploy stale/empty assets:

```toml
# wrangler.toml — was RR7's react-router build output
- assets = { directory = "./build/client/", binding = "ASSETS" }
+ assets = { directory = "./dist/client/",  binding = "ASSETS" }
```

```jsonc
// package.json — clean the real output dir
- "cleanup": "rimraf ./build ./public/build"
+ "cleanup": "rimraf ./dist ./build ./public/build"
```

### 10e. Deploy the built worker, not the source entry

`vite build` emits the **deployable** Worker config at `dist/<env>/wrangler.json`
with `main: "index.js"` (the bundled worker), `no_bundle: true`, and
`assets: "../client"`. A plain `wrangler deploy` run from the repo root uses the
**root** `wrangler.toml`, where `main` points at your **source** entry
(`app/.../worker.ts`) — and wrangler's bundler cannot resolve Rango's
`virtual:rsc-router/*` modules, so deploying the source entry fails or ships a
broken worker. Deploy the build output instead (e.g.
`wrangler deploy -c dist/<env>/wrangler.json`) or use the plugin's deploy flow.
RR7's `wrangler deploy` from root worked only because its worker was already
fully bundled by `react-router build`.
