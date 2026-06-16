# rangojs-vercel-basic

A minimal Rango app deployed to **Vercel Functions**, caching segment and
`"use cache"` results in the **Vercel Runtime Cache** via `VercelCacheStore`.

It uses the Rango **node preset** (Vercel runs Node Functions, not Workers) and
assembles a Vercel **Build Output API v3** directory (`.vercel/output`) from the
Vite build. The server runs as a single Node Function that streams the RSC/HTML
response; static client assets are served from the CDN.

> This is the prototype for a future first-class `rango({ preset: "vercel" })`.
> The deployment glue lives in `scripts/` here so the pattern can be proven
> before it is promoted into the published `@rangojs/router` Vite plugin. See
> `docs/design/vercel-cache-store.md` for the target design.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server (in-memory cache store). |
| `pnpm build` | `vite build`, then assembles `.vercel/output`. |
| `pnpm smoke` | Serves the assembled function over `node:http` and asserts the pages render + a static asset loads. No deploy. |
| `pnpm preview` | `vite preview` (plugin-rsc's Node server; in-memory cache store). |

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

`--prebuilt` uploads the existing `.vercel/output` without rebuilding on Vercel.
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

## How the deployment is assembled

`scripts/vercel-build.mjs` (run after `vite build`):

1. `dist/client` → `.vercel/output/static/` (browser assets, served at `/`).
2. `dist/rsc` + `dist/ssr` → `.vercel/output/functions/index.func/{rsc,ssr}/`,
   preserving the `rsc → ../ssr/index.js` runtime import. `dist/rsc/index.js` is
   already fully self-contained (no bare `node_modules` imports), so nothing else
   is copied.
3. `scripts/func-entry.mjs` is bundled to `index.func/index.mjs` — it wraps the
   Rango Web fetch handler with `srvx`'s `toNodeHandler` (the Node launcher needs
   a `(req, res)` handler, not a `{ fetch }` object) and forwards `process.env` +
   `waitUntil`. `srvx` and `@vercel/functions` are inlined; the RSC bundle stays
   a runtime-relative external.
4. `.vc-config.json` (`runtime: nodejs22.x`, `launcherType: Nodejs`,
   `supportsResponseStreaming: true`, `shouldAddHelpers: false`) and `config.json`
   (`{ handle: "filesystem" }` then `/(.*) → /index`) are written.
