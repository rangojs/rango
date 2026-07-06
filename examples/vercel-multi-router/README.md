# Rango on Vercel — multi-app host router

A multi-app **host router** deployed to Vercel as a single Build Output function.
`src/worker.rsc.tsx` calls `createHostRouter()` and **exports the instance**; rango
owns the generated RSC entry (selected via the `hostRouter` option in
`vite.config.ts`) and serves it with `hostRouter.match()` for every request.

```ts
// vite.config.ts
rango({ preset: "vercel", hostRouter: "./src/worker.rsc.tsx" });
```

Two sub-apps mounted by host: `a.localhost` → App A, `b.localhost` → App B. There
is no catch-all, so an unmatched host returns **404** (the generated entry catches
`NoRouteMatchError`). To serve a default app instead, add a last `host(["**"])` mount.

## Scripts

- `pnpm build` — produces `.vercel/output` (Build Output API v3).
- `pnpm smoke` — builds, then drives the isolated function with Host headers and
  asserts each sub-app renders and an unmatched host 404s (no deploy needed). Runs
  in CI as the `vercel-smoke` job.
- `pnpm dev` / `pnpm preview` — local dev / preview of the node build.
