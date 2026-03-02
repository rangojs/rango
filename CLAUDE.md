- Do not add "Co-Authored-By" or "Generated with Claude Code" lines to commits or PRs.
- When writing code comments, never use icons and emojis. Keep comments technical and focused on implementation details.
- Before working on routing, run `/rango` to understand the API. Skills are in `node_modules/@rangojs/router/skills/`.
- Run the full test suite with `pnpm test` from the repo root.
- **CRITICAL**: Before EVERY push, ALWAYS run ALL of the following and fix any failures. No exceptions:
  1. `pnpm run typecheck` (typecheck)
  2. `pnpm run test:unit` (unit tests — from `packages/rangojs-router`)
  3. `pnpm run lint` (oxlint)
  4. `pnpm run format` (oxfmt — run without `--check` to fix)
- After changing router Vite plugin code (`packages/rangojs-router/src/vite/`), rebuild with `pnpm build-router` before running `pnpm dev`.
- **HMR watcher tests** (`route-types-hmr.test.ts`) are skipped on CI due to unreliable file watcher behavior on GitHub Actions. When changing route types generation or the Vite plugin watcher code, run these tests locally before opening a PR: `pnpm --filter @rangojs/router exec playwright test route-types-hmr --project=hmr`
- **MANDATORY**: All e2e tests MUST cover BOTH dev AND production modes. Never write a dev-only test. When adding new e2e test cases, always add the production counterpart. Verify output in both modes. Any gap in production test coverage must be flagged immediately — it is not acceptable. Test the cloudflare basic app and e2e test app.

## Router Internals

- `packages/rangojs-router/docs/tree-structure.md` — Tree-structure-critical files and rules. Read before modifying segment rendering, merging, or wrapper components.

## Design Documents

Before implementing features, check the design docs for target architecture:

- `docs/design/caching.md` — Segment-level caching design (runtime cache)
- `packages/rangojs-router/docs/prerender-api-design.md` — **Pre-rendering design** (canonical). Defines the core principle (prerender = build-time cache), B segment type, BuildContext, handler eviction, storage layout, passthrough mode, runtime flow, and interaction with caching/loaders/actions.

**Pre-rendering architecture rule**: Pre-rendering is caching at build time. The worker handles every request — there are NO static .html or .rsc files served from assets. At runtime, the worker looks up stored Flight payloads (serialized segments) and passes them to the segment system, identical to a cache hit. The browser does not know if a route was pre-rendered. Read `packages/rangojs-router/docs/prerender-api-design.md` before making ANY changes to pre-rendering.
