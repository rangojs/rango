- Do not add "Co-Authored-By" or "Generated with Claude Code" lines to commits or PRs.
- When writing code comments, never use icons and emojis. Keep comments technical and focused on implementation details.
- Before working on routing, run `/rango` to understand the API. Skills are in `node_modules/@rangojs/router/skills/`.
- Run the full test suite with `pnpm test 2>&1 | tail -80` from the repo root. The output is massive; always pipe through `tail -80` to see the summary.
- **CRITICAL**: Avoid burst-pushing multiple commits in quick succession to `main` or PR branches. Each push triggers a full CI run (~12 min, expensive). Squash related fixes into a single commit before pushing. If a review produces follow-up fixes, amend or squash them into one commit rather than pushing 2-3 separate fixups.
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
