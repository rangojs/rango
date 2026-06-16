# rangojs-vercel-basic

A minimal Rango app deployed to **Vercel Functions**, caching segment and
`"use cache"` results in the **Vercel Runtime Cache** via `VercelCacheStore`.

It uses the **`rango({ preset: "vercel" })`** preset: it builds like the node
preset (Vercel runs Node Functions, not Workers), folds `NODE_ENV` for the
SSR/RSC build, and after `vite build` assembles a Vercel **Build Output API v3**
directory (`.vercel/output`) — a single Node Function that streams the RSC/HTML
response, plus the static client assets served from the CDN.

```ts
// vite.config.ts
import { rango } from "@rangojs/router/vite";
export default defineConfig({
  plugins: [react(), rango({ preset: "vercel" })],
});
```

The app installs `@vercel/functions` (used by `VercelCacheStore` and bundled into
the generated function launcher). `srvx` (the Web→Node streaming bridge) and the
`.vercel/output` assembler are provided by the preset — no app-local glue.

## Commands

| Command        | What it does                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`     | Vite dev server (in-memory cache store).                                                                       |
| `pnpm build`   | `vite build` — the preset assembles `.vercel/output`.                                                          |
| `pnpm smoke`   | Serves the assembled function over `node:http` and asserts the pages render + a static asset loads. No deploy. |
| `pnpm preview` | `vite preview` (plugin-rsc's Node server; in-memory cache store).                                              |

## Local verification (no Vercel account)

```bash
pnpm build      # produces dist/ and .vercel/output
pnpm smoke      # imports the bundled function and exercises it
```

`smoke` imports `.vercel/output/functions/index.func/index.mjs` (which throws if
the bundle is not self-contained), serves it behind the same "static first, else
function" routing Vercel uses, and checks `/`, `/about`, `/cached`, and a static
asset. Locally the app falls back to the in-memory cache store, so `/cached`
demonstrates a real segment-cache hit (the timestamp freezes within the TTL).

## Deploying to Vercel

`pnpm build` writes a complete `.vercel/output`, so deploy the prebuilt output:

```bash
pnpm dlx vercel login
pnpm dlx vercel link          # link to a Vercel project (once)
pnpm build
pnpm dlx vercel deploy --prebuilt --archive=tgz
```

On the platform `process.env.VERCEL` is set, so the router switches to
`VercelCacheStore` backed by `getCache()`; tag invalidation uses `expireTag`
(global, ~300ms). The deployment id is folded into the cache namespace so a
redeploy does not serve stale-shaped entries.

## What needs the real platform to verify

The local smoke test covers the build output, self-containment, HTML streaming,
and static serving. These require an actual Vercel deployment to confirm:

- `getCache()` / `expireTag()` / `waitUntil` runtime behavior (no-ops or throws
  off-platform).
- Response streaming under the real Node launcher (`supportsResponseStreaming`).
- Cross-region cache behavior and tag-invalidation propagation.

## What the preset does

`rango({ preset: "vercel" })` (in `@rangojs/router/vite`):

1. Builds the three Vite environments (client / ssr / rsc) like the node preset,
   and folds `process.env.NODE_ENV` for the build.
2. After the build, restructures `dist/` into `.vercel/output`: `dist/client` →
   `static/`; `dist/{rsc,ssr}` → `functions/index.func/` (preserving the
   `rsc → ../ssr/index.js` runtime import; `dist/rsc/index.js` is already fully
   self-contained).
3. Bundles a Node launcher (`index.func/index.mjs`) that wraps the Rango Web
   fetch handler with `srvx`'s `toNodeHandler` (the Node launcher needs a
   `(req, res)` handler) and forwards `process.env` + `waitUntil`.
4. Writes `.vc-config.json` (`runtime: nodejs22.x`, `supportsResponseStreaming`)
   and `config.json` (`{ handle: "filesystem" }` then `/(.*) → /index`).

Tune the function via `rango({ preset: "vercel", vercel: { runtime, maxDuration,
memory, regions, functionName } })`.
