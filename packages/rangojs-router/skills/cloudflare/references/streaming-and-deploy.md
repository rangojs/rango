# Streaming, preview, and deployment

## Contents

- [Keep streamed responses intact](#keep-streamed-responses-intact)
- [Use Vite for local RSC work](#use-vite-for-local-rsc-work)
- [Handle route-owned CORS](#handle-route-owned-cors)
- [Deploy the built Worker](#deploy-the-built-worker)
- [Debug a dev-preview difference](#debug-a-dev-preview-difference)

## Keep streamed responses intact

Anything that awaits the full Rango response body removes streaming:

```typescript
// Wrong: drains the stream.
const response = await router.fetch(request, { env, ctx });
const html = await response.text();
return new Response(rewrite(html), response);

// Correct: preserve the body stream while changing headers.
const response = await router.fetch(request, { env, ctx });
const headers = new Headers(response.headers);
headers.set("X-App", "worker");
return new Response(response.body, {
  status: response.status,
  statusText: response.statusText,
  headers,
});
```

Keep buffering on a legacy proxy branch if it is required there, but never run
it on the `router.fetch()` branch.

## Use Vite for local RSC work

Use `vite dev` and `vite preview`. The Cloudflare Vite plugin runs the Worker
inside Miniflare/workerd with the same binding shape as deployment.

Avoid diagnosing streaming with `wrangler dev`: local gzip compression can
buffer the response. If that tool is unavoidable, compare
`Accept-Encoding: identity` and `Accept-Encoding: gzip` before blaming the
router. Deployed Cloudflare compression streams.

Verify first-byte behavior directly:

```bash
curl --no-buffer --raw -H 'Accept-Encoding: identity' http://localhost:5173/slow
```

## Handle route-owned CORS

Vite's CORS middleware answers preflight `OPTIONS` before the Worker in both
`vite dev` and `vite preview` by default. A preview preflight therefore does not
prove that the deployed route's own `OPTIONS` branch works.

When the Worker must own exact CORS headers, disable the outer Vite CORS layer
in both modes:

```typescript
export default defineConfig({
  server: { cors: false },
  preview: { cors: false },
  // plugins...
});
```

Assert the full CORS set on a real non-preflight response as well as the route's
`OPTIONS` response. Keep a deployed smoke check for the final edge behavior.

## Deploy the built Worker

`vite build` writes client assets to `dist/client` and a deployable Worker
configuration under the RSC environment output, normally
`dist/rsc/wrangler.json`. That generated config points at the bundled Worker and
sets the client asset directory correctly.

```bash
pnpm exec vite build
pnpm exec wrangler deploy -c dist/rsc/wrangler.json
```

Do not deploy the source `main` from the root config after building. Wrangler's
bundler cannot reconstruct Rango's Vite virtual modules. If the RSC environment
has a custom name, use its matching `dist/<name>/wrangler.json` path.

Before deployment:

- replace placeholder D1/KV IDs;
- apply remote D1 migrations;
- provision each production secret with `wrangler secret put`;
- run the preview parity suite against a fresh build;
- confirm no server-only secret appears in `dist/client`;
- smoke-test streaming and redirects on the deployed edge.

## Debug a dev-preview difference

1. Build immediately before preview; stale `dist` output invalidates the test.
2. Compare the actual `.dev.vars`/bindings visible in each mode.
3. Send `Accept: text/html` or no `Accept` for a document request; send
   `Accept: text/x-component` only when testing Flight.
4. Disable automatic redirect following when inspecting a 3xx.
5. Test the target URL first on a fresh preview process, then after the redirect.
6. Capture both curl timing and the Worker's request log. A request absent from
   the Worker log is stuck in the outer Vite/Cloudflare layer.
7. Reduce the case to one route before assigning ownership to Rango, Vite, or
   the Cloudflare plugin.
