# Rango docs site (WIP)

Documentation site built on `@rangojs/router` (RSC + Vite), deployed to
Cloudflare Workers (`cloudflare` preset + `@cloudflare/vite-plugin`). Started
from the Vercel Shop docs design; content is still the shop placeholder and
will be replaced with Rango documentation.

## Development

```bash
pnpm dev      # generates content metadata, then vite dev (miniflare)
pnpm build    # generates content metadata, then vite build
pnpm preview  # serve the production build in workerd
pnpm deploy   # wrangler deploy
```

Set the `SITE_URL` wrangler var on the deployed worker so the
machine-readable routes (llms.txt, sitemap.xml, rss.xml) emit absolute URLs
with the real origin.

## Structure

- `content/docs/` — MDX pages; `meta.json` files control sidebar order.
- `scripts/gen-content.mjs` — generates `src/content.gen.ts` (page metadata,
  nav tree, table of contents) from `content/docs/`. Runs automatically before
  `dev` and `build`; run manually with `pnpm content:gen`.
- `src/router.tsx` — router entry: document, theme, segment cache
  (`CFCacheStore`, namespaced per worker version).
- `src/worker.rsc.tsx` — Workers fetch handler; `wrangler.json` points here.
- `src/urls.tsx` — route definitions.
- `src/routes/` — home, docs, and machine-readable (llms.txt / markdown
  negotiation) route handlers.
- `lib/site.ts` — site name, titles, base-URL resolution (branding lives here).
- `components/` — home-page sections, docs chrome, and shadcn/ui primitives.

## Notes

- MDX is compiled via a `load`-hook wrapper around `@mdx-js/rollup` so
  prerendering works (see the comment in `vite.config.ts`).
- Lint/format are owned by the repo root (`pnpm run lint`, `pnpm run format`);
  this package intentionally has no local oxlint/oxfmt config.
