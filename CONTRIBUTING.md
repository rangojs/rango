# Contributing

Thanks for wanting to help. This repo has a high merge bar on purpose: the
router's value is a tested execution contract (middleware scope, handler-first
ordering, JS / progressive-enhancement parity, cache isolation), not a growing
API surface.

Read this before opening a PR. Coding agents should also read
[`AGENTS.md`](./AGENTS.md) — it is the working contract for changes here.

## What we will review

- Bug fixes with a regression test that failed before the fix and passes after
- Execution-model or security fixes that update the semantic matrix and
  `packages/rangojs-router/docs/internal/execution-model.md` in the same PR
- Small, motivated API additions that ship the full definition of done (below)
- Docs / skill fixes that match shipped behavior

## What we will close

- Drive-by refactors, formatting-only PRs, and "cleanup" with no failing test
- New public API without userland coverage through
  `@rangojs/router/testing` and without paired dev + production e2e
- PRs that add a feature but leave `*.gen.ts` stale in any app
- Generated "Co-Authored-By" / "Generated with …" commit or PR attribution
- Security reports filed as public issues — use [`SECURITY.md`](./SECURITY.md)

Please open an issue (or RFC) before a large change. Unsolicited architecture
rewrites will not be merged.

## Development setup

- Node.js 24 (CI and `engines` for the published package)
- pnpm 11+ (see root `packageManager`)

```bash
pnpm install
pnpm --filter @rangojs/router build
pnpm typecheck
```

`pnpm <script>` can fail locally (lefthook / verifyDeps). Prefer the binaries:

```bash
./node_modules/.bin/vitest run
./node_modules/.bin/playwright test --project=production --no-deps --grep "<fragment>"
```

E2e ports are per-checkout, not the documented bases — see `AGENTS.md`.

## Definition of done

A consumer-touchable change (new `ctx.*` method, hook, DSL primitive, handle
behavior, middleware semantic) is done only when all of these hold:

1. Internal unit tests for the implementation module
2. A userland test through the public `@rangojs/router/testing` primitives
3. Dev **and** production e2e (never a dev-only case)
4. `*.gen.ts` committed in every app if routes changed
5. Internal reference docs updated in the same PR
   (`docs/internal/feature-map.md`, `feature-file-map.md`, and the relevant
   design/execution doc)
6. The pre-push gate is green (below)

If a testing primitive cannot reach the feature, extend the primitive in the
same PR. Do not stub production wiring.

## Pre-push gate

From the repo root, in this order, and fix failures before push:

```bash
pnpm run typecheck
pnpm run test:unit:all
pnpm run lint
pnpm run format
```

`test:unit:all` is unit + Flight/RSC suites for **every** package, not just
`@rangojs/router`. `--no-verify` is only for `*.gen.ts` formatter-hook
rejections.

Intentional semantic changes must keep
`packages/rangojs-router/e2e/semantic-matrix.test.ts` green and update
`docs/internal/execution-model.md`.

## Code conventions

Match the surrounding file. Router source specifically:

- Strict TypeScript with `isolatedDeclarations` — every export has an explicit
  type annotation
- ESM with explicit `.js` extensions on relative imports, even from `.ts`
- Named exports only; no default exports
- Files `kebab-case.ts`, types `PascalCase`, constants `SCREAMING_SNAKE_CASE`
- Comments are terse and technical. Non-obvious invariants get a JSDoc block
  that says **why**, with file/identifier references. Do not narrate the diff.

Check `packages/rangojs-router/docs/internal/feature-file-map.md` before adding
a file — the feature may already have an owning module.

## CI on pull requests

GitHub Actions jobs run only for branches on this repository. A pull request
from a fork skips the entire CI graph — that is intentional. Open the PR from
a branch on `rangojs/rango`, or wait for a maintainer to pull the branch here
after reviewing any `.github/workflows/` diffs.

Playwright e2e, bundle guards, and `pkg.pr.new` still require a non-draft
same-repo PR (or the `ci:e2e` label on an otherwise-gated run).

## Pull request shape

Lead with the outcome: what a consumer writes, sees, or hits differently.
Include a before/after snippet for consumer-visible changes, name the tests
that pin the contract, and list anything deliberately left unchanged.

Squash related fixes. Do not burst-push — each push starts a long CI run.
