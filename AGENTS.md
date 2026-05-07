- Do not add "Co-Authored-By" or "Generated with Claude Code" lines to commits or PRs.
- When writing code comments, never use icons and emojis. Keep comments technical and focused on implementation details.
- Before working on routing, run `/rango` to understand the API. Skills are in `node_modules/@rangojs/router/skills/`.
- Run the full test suite with `pnpm test 2>&1 | tail -80` from the repo root. The output is massive; always pipe through `tail -80` to see the summary.
- **CRITICAL**: Avoid burst-pushing multiple commits in quick succession to `main` or PR branches. Each push triggers a full CI run (~12 min, expensive). Squash related fixes into a single commit before pushing. If a review produces follow-up fixes, amend or squash them into one commit rather than pushing 2-3 separate fixups.
- **CRITICAL**: Always commit `router.named-routes.gen.ts` when adding/removing/renaming test-app routes. This generated file must stay in sync with the route definitions. Use `--no-verify` if the formatter hook rejects it.
- **CRITICAL**: Before EVERY push, ALWAYS run ALL of the following and fix any failures. No exceptions:
  1. `pnpm run typecheck` (typecheck)
  2. `pnpm run test:unit` (unit tests — from `packages/rangojs-router`)
  3. `pnpm run lint` (oxlint)
  4. `pnpm run format` (oxfmt — run without `--check` to fix)
- After changing router Vite plugin code (`packages/rangojs-router/src/vite/`), rebuild with `pnpm build-router` before running `pnpm dev`.
- **HMR watcher tests** (`route-types-hmr.test.ts`) are skipped on CI due to unreliable file watcher behavior on GitHub Actions. When changing route types generation or the Vite plugin watcher code, run these tests locally before opening a PR: `pnpm --filter @rangojs/router exec playwright test route-types-hmr --project=hmr`
- **MANDATORY**: All e2e tests MUST cover BOTH dev AND production modes. Never write a dev-only test. When adding new e2e test cases, always add the production counterpart. Verify output in both modes. Any gap in production test coverage must be flagged immediately — it is not acceptable. Test the cloudflare basic app and e2e test app.

## API Hygiene

- **Pre-release rule**: No deprecated public API in main before first stable external adoption. Remove transitional types and functions instead of marking them deprecated.
- Treat examples as part of the API surface. If an example uses an old pattern, it reads as endorsed. Example cleanup is API cleanup.

## Pull Request Descriptions

PR descriptions must tell the **consumer-side story** alongside the code change. A reviewer should be able to read the PR and understand: what does a consumer write differently, what do they see differently, and what happens if they don't adopt the change. Code-level mechanics are necessary but not sufficient — if the PR changes anything a consumer can touch (public API, middleware semantics, error shapes, HTTP responses, generated types, DX defaults), the description must show it from the consumer's seat. Do **not** trim code-change details to make room — add the consumer narrative on top. Short chore/version-bump PRs are exempt.

Every non-trivial PR description must include:

1. **One-paragraph problem statement** — what broke or what was missing, stated in consumer-observable terms (e.g. "miniflare returned an opaque 500 instead of the 302 the middleware intended"), not just internal call-site terms.
2. **Before vs. after usage example** — a real code snippet a consumer would write, showing the old behavior (or old workaround) and the new behavior side by side. Use the same snippet shape for both so the delta is obvious.
3. **At least one end-to-end consumer example** — a realistic, copy-pasteable fragment (middleware, handler, component, config — whichever layer the change touches) that exercises the new behavior in a way that reflects actual product usage, not a toy case.
4. **Semantics table when behavior branches** — if the change introduces or clarifies multiple cases (return vs. throw, authed vs. unauthed, dev vs. production, etc.), include a small markdown table covering each case and the resulting behavior. Include cases the PR deliberately leaves unchanged, so the contract is readable in one place.
5. **Code-change summary** — the file(s) touched, the shape of the diff (ideally the key block inline), and _why_ that location was chosen over alternatives. This is the existing bar; do not shrink it.
6. **Test plan checklist** — unit + e2e (dev + production), typecheck, lint, format. Call out any test that is new and what contract it pins down.
7. **Notes / call-outs** — surprising interactions with adjacent subsystems, migration implications for consumers on the prior behavior, or follow-ups deliberately deferred.

PR #481 (`fix(router): throw Response from top-level middleware short-circuits`) is a reference template — match its structure for consumer-facing fixes and features.

## Semantic Contract

- **Semantic matrix** (`packages/rangojs-router/e2e/semantic-matrix.test.ts`): This test encodes the router's core execution guarantees. Any change to middleware scope, handler-first ordering, context visibility, or PE/JS parity MUST keep the semantic matrix green. If a semantic change is intentional, update the matrix rows to match the new contract AND update `packages/rangojs-router/docs/internal/execution-model.md`.
- Before modifying segment resolution (`src/router/segment-resolution/`), middleware (`src/router/middleware.ts`), or progressive enhancement (`src/rsc/progressive-enhancement.ts`), run the semantic matrix: `pnpm --filter @rangojs/router exec playwright test semantic-matrix`

## Router Internals

- `packages/rangojs-router/docs/tree-structure.md` — Tree-structure-critical files and rules. Read before modifying segment rendering, merging, or wrapper components.

## Internal Reference Docs

The following docs in `packages/rangojs-router/docs/` must stay in sync with the codebase:

- `docs/README.md` — docs navigation hub; update when adding or removing doc files
- `docs/internal/feature-map.md` — export surface tables and capability inventory; update when exports, hooks, DSL primitives, or architectural layers change
- `docs/internal/feature-file-map.md` — feature-to-source-file ownership map; update when files are added, removed, renamed, or when feature ownership shifts

When a PR changes exports, adds/removes source files, or introduces new features, update these docs in the same PR.

## Design Documents

Before implementing features, check the design docs for target architecture:

- `docs/design/caching.md` — Segment-level caching design (runtime cache)
- `packages/rangojs-router/docs/prerender-api-design.md` — **Pre-rendering design** (canonical). Defines the core principle (prerender = build-time cache), B segment type, BuildContext, handler eviction, storage layout, passthrough mode, runtime flow, and interaction with caching/loaders/actions.

**Pre-rendering architecture rule**: Pre-rendering is caching at build time. The worker handles every request — there are NO static .html or .rsc files served from assets. At runtime, the worker looks up stored Flight payloads (serialized segments) and passes them to the segment system, identical to a cache hit. The browser does not know if a route was pre-rendered. Read `packages/rangojs-router/docs/prerender-api-design.md` before making ANY changes to pre-rendering.

## Bundle Hygiene

Two failure modes that tree-shaking **cannot** catch — both have produced large regressions in this repo (see commits `d10a2470`, `e56f2ee2`):

1. **Generated data must have a single ownership chunk.** When a Vite virtual module emits route data via `JSON.parse('<huge string>')` (or any inlined data structure with side effects), do **not** put the same data in both an eager module and a lazy per-router chunk. Tree-shaking treats both as live code with side effects. Pick one: eager OR lazy. The router's contract is now lazy-only (`virtual:rsc-router/routes-manifest/<routerId>`), populated via `await ensureRouterManifest(routerId)` before any matching. Don't add `setRouteTrie`/`setPrecomputedEntries` calls to the eager manifest.
2. **Fold `process.env.NODE_ENV` at build time for SSR/RSC.** React's CJS files use `if (process.env.NODE_ENV !== "production") { ...dev... } else { ...prod... }`. If the conditional isn't folded at build time, the minifier keeps **both branches**, doubling React's footprint. The Cloudflare vite plugin folds NODE_ENV automatically; vanilla `vite build` folds for client but not SSR/RSC. Any new non-Cloudflare app config MUST set `define: { "process.env.NODE_ENV": JSON.stringify("production") }` for build mode. Reference: `packages/rangojs-router/e2e/test-app/vite.config.ts`.

**Bundle guard**: `packages/rangojs-router/e2e/build-test-app.setup.ts` walks `dist/` after every production build and fails if any `react*.development*.js` chunk appears. This catches regressions of rule #2.

**Investigating bundle issues**: opt-in analyzer at `tools/bundle-analyze.ts`. Run `RANGO_ANALYZE=1 pnpm exec vite build` in any wired app (all 4 CF apps, e2e/test-app, e2e/e2e-basic) to emit per-environment treemap reports to `<app>/bundle-stats/{client,ssr,rsc}.html`. The visualizer caches options after the first call, so the helper registers a separate plugin instance per Vite environment via `applyToEnvironment` — don't replace it with a single visualizer call.

**Client-runtime optimizations investigated and rejected** (don't redo this without new information):

- `browser/server-action-bridge.ts` (~3.5 KB gzip in client) — *cannot* lazy-load without adding a chunk fetch on first server-action invocation. Server actions are fundamental to almost every Rango app, so the win applies to a rare case while the cost hits the common one.
- `theme/ThemeProvider.tsx` + `ThemeScript.tsx` + `theme/constants.ts` (~3 KB combined) — statically imported in `NavigationProvider.tsx` and conditionally wrapped. *Cannot* lazy-load: theme is FOUC-prevention, the class must be on `<html>` before first paint, so a chunk fetch before paint defeats the feature.
- `browser/react/NavigationProvider.tsx` per-feature splitting (~1.9 KB) — internal feature gates (location-state, scroll restoration, view transitions) are context-shape and exist for type-checking regardless of configuration. Splitting into per-feature Providers is significant API churn for a sub-2 KB win.
- `browser/partial-update.ts` (~2.8 KB) — shared RSC stream reconciler used on every navigation and every action response. Lazy-loading would add a chunk fetch before the first navigation; there is no path that improves cold-start.

The Rango client runtime baseline is **~50 KB gzip** across CF apps; the React + RSC client baseline is **~115 KB gzip** (react-dom 96K + react 5K + rsd-webpack-client 12K + scheduler 3K). Further client-side reductions require architectural changes (e.g., a smaller RSC client serializer, or React Compiler output) — not surgical edits to existing modules.
