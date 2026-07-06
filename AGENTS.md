# Agent guide

Contract for any coding agent in this repo (CLAUDE.md symlinks here). **Hard rules** are never violated; everything else is strong guidance. Where a rule comes with a why, the rule is the contract — the why exists so you don't break it in a novel way.

## Repo map

- `packages/rangojs-router/` — the `@rangojs/router` package (the product).
- `packages/rangojs-router/e2e/` — the router's own e2e apps and suites (test-app, mini, e2e-basic, …). NOT a root `e2e/` directory.
- `tests/` — consumer app suites (cloudflare-basic, vite-rsc-demo, no-typescript, react-experimental, …) that dogfood the published API.
- `examples/`, `apps/` — example/demo apps. Examples are API surface: an old pattern in an example reads as endorsed.
- `docs/` (root) and `packages/rangojs-router/docs/` — design docs and internal reference docs.
- `tools/` — repo check scripts (`check:e2e-bucketing`, `check:docs-api`, bundle analyzer, …).

## If you are about to…

| Task                                                                                                         | Obligation                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work on routing / the DSL                                                                                    | First read the router skills: `/rango` skill, or `node_modules/@rangojs/router/skills/*/SKILL.md` directly if your harness has no skills              |
| Modify `src/router/segment-resolution/`, `src/router/middleware.ts`, or `src/rsc/progressive-enhancement.ts` | Run `pnpm --filter @rangojs/router exec playwright test semantic-matrix` before push                                                                  |
| Change Vite plugin code (`packages/rangojs-router/src/vite/`)                                                | `pnpm build-router` before `pnpm dev`; run `pnpm --filter @rangojs/router exec playwright test route-types-hmr --project=hmr` locally (skipped on CI) |
| Add/remove/rename routes                                                                                     | Commit `*.gen.ts` in EVERY app (Hard rule 2)                                                                                                          |
| Change pre-rendering                                                                                         | First read `packages/rangojs-router/docs/prerender-api-design.md`                                                                                     |
| Change caching                                                                                               | First read `docs/design/caching.md`                                                                                                                   |
| Modify segment rendering, merging, or wrapper components                                                     | First read `packages/rangojs-router/docs/tree-structure.md`                                                                                           |
| Add any e2e test                                                                                             | Both a dev AND a `(production)` describe (Hard rule 3 + bucketing)                                                                                    |
| Change exports or add/remove source files                                                                    | Update the Internal reference docs in the same PR                                                                                                     |
| Locate where a feature lives                                                                                 | Start from `docs/internal/feature-map.md` and `docs/internal/feature-file-map.md`                                                                     |

## Hard rules

1. **Pre-push gate.** Before EVERY push, from the repo root, fix any failures in:
   1. `pnpm run typecheck`
   2. `pnpm run test:unit:all` (= `test:unit` + `test:unit:rsc`, both recursive) — runs unit AND Flight/RSC suites for **every package**: the router plus every consumer app. Never substitute `pnpm --filter @rangojs/router test:unit`; a change can pass the router's tests while breaking a consumer app's `@rangojs/router/testing` dogfood suite. CI's `unit-tests` job runs the same two scripts.
   3. `pnpm run lint` (oxlint `--deny-warnings`)
   4. `pnpm run format` (check) — `pnpm run format:fix` to fix.
2. **Generated route files.** When routes change, commit `router.named-routes.gen.ts` and all other `*.gen.ts` in **every** app, not just the one you touched — a stale `.gen.ts` breaks CI even when the source change looks complete. Check before push: `git status --porcelain | grep '\.gen\.ts'` must be empty.
3. **Dev + production e2e coverage.** Never write a dev-only e2e test; every new case gets a production counterpart, verified in both modes. Cover the cloudflare-basic app and the e2e test-app. Any production-coverage gap must be flagged immediately.
4. **No burst-pushing.** Each push triggers a ~12-min CI run. Squash related fixes into one commit; amend rather than pushing separate fixups.
5. **Semantic matrix stays green.** `packages/rangojs-router/e2e/semantic-matrix.test.ts` encodes the router's core execution guarantees (middleware scope, handler-first ordering, context visibility, PE/JS parity). Intentional semantic changes update the matrix rows AND `docs/internal/execution-model.md`.
6. **`--no-verify` only for `*.gen.ts` formatter-hook rejections.** Never to bypass failing checks on source files.
7. **No "Co-Authored-By" or "Generated with Claude Code" lines** in commits or PRs.

## Definition of done (shipping a feature)

A consumer-touchable feature (new `ctx.*` method, hook, DSL primitive, handle behavior, middleware semantic) is done only when ALL hold:

1. Internal unit tests for the implementation module.
2. A userland test through the public testing primitives (see below).
3. Dev + production e2e coverage (Hard rule 3).
4. `*.gen.ts` committed everywhere if routes changed (Hard rule 2).
5. Internal reference docs updated in the same PR.
6. PR description per the contract below; its test plan names the userland test and the consumer-visible contract it pins.
7. Pre-push gate passes (Hard rule 1).

## Communication and tone

For commit messages, PR text, review findings, and status reports:

- **Lead with the outcome** — first sentence answers "what happened / what did you find"; detail after.
- **State things directly.** Never "honest"/"honestly" ("one caveat", not "one honest caveat"). No emoji anywhere. No marketing tone.
- **Report failures faithfully.** Failing tests get stated with output. Never call a failure "pre-existing" without running it on the base commit.
- **Don't overstate findings.** Before calling something a gap, verify it isn't already a working configurable feature. Behavior claims need a file reference or a demonstrating command.
- **Regression tests are proven red-before-green** — shown failing without the fix, passing with it, output captured in the PR.
- **Precision over hedging.** `path:line` references, exact identifiers, measured numbers. "Roughly"/"should" signal you haven't verified.
- **Be token-lean.** Don't restate file contents or logs back; quote only the lines that carry the finding.

## Coding guide

Match the surrounding code first; repo-wide conventions:

- **Strict TS with `isolatedDeclarations`**: every export needs an explicit type annotation — annotate, don't restructure to dodge it.
- **ESM with explicit `.js` extensions** on relative imports, even from `.ts`. `import type` / `export type` for type-only.
- **Named exports only**; no default exports in router source.
- Constants `SCREAMING_SNAKE_CASE`, files `kebab-case.ts`, types `PascalCase`.
- **Comments**: technical, terse, no emoji/icons. Non-obvious invariants get a JSDoc block explaining WHY (scar tissue welcome) with exact file/identifier references. Never narrate the diff or address a reviewer.
- **oxfmt owns formatting** (no hand-alignment); oxlint runs `--deny-warnings` — fix, don't suppress.
- **Check `docs/internal/feature-file-map.md` before creating a file** — the feature may already have an owning module.
- **Pre-release API hygiene**: no deprecated public API in main before first stable external adoption — remove transitional types/functions instead of deprecating.

## Environment gotchas

- `pnpm <script>` can fail locally (verifyDepsBeforeRun → install → lefthook). Run binaries directly instead: `./node_modules/.bin/vitest run`, `./node_modules/.bin/playwright test …` — or reuse running Playwright servers. Don't debug the pnpm wrapper.
- **E2e ports are per-checkout, not the documented bases.** The shared Playwright webServer ports (rangojs-router base 5188/5189 + host 5296/5297, cloudflare-basic 5198/5199) are shifted by an automatic per-clone offset (`checkoutPortOffset()` in `tests/shared-e2e` — hash of the checkout path) so parallel clones can't silently test each other's servers or kill them mid-run (scar tissue: PR #705 verification chased phantom failures for an hour). Read the actual ports from playwright's webServer command output; `RANGO_E2E_PORT_OFFSET=<n>` overrides (0 forces the bases); CI pins 0. Never hardcode a port in cleanup commands (`lsof ... | kill`) — derive it the same way.
- Full suite output is massive: `pnpm test 2>&1 | tail -80` from the repo root.
- Format-fix commits go AFTER CI passes on the substantive commit, with `[skip ci]`.
- Lefthook pre-commit runs formatting and `check:e2e-bucketing`; if your harness bypasses hooks, run `pnpm run format` and `pnpm check:e2e-bucketing` manually.

## Spawning subagents

If your harness supports subagents (Task/Agent tool), use them well:

- **Spawn for breadth, search directly for depth.** A subagent pays off when the answer spans many files (audit, sweep, "where is X handled across apps") or when work is independent and parallelizable. For a single known file/symbol, grep yourself — a spawn costs more than the lookup.
- **Launch independent agents in parallel** (one message, multiple calls). Chain only when one agent's output feeds the next. Don't also do the delegated work yourself.
- **Prompts must be self-contained.** Agents don't see your conversation. Give: exact paths (see Repo map — e2e apps are under `packages/rangojs-router/e2e/`, not root), the commands to run, what "done" means, and the exact return shape you want (`path:line` list, diff, verdict + evidence). Vague prompts return vague essays.
- **Hard rules don't auto-propagate.** An agent writing code must be told the ones its task can violate: dev+prod e2e pairing, `*.gen.ts` in every app, `isolatedDeclarations` annotations, no default exports. Paste the specific rules into the prompt, not "follow AGENTS.md".
- **Pass the environment gotchas** to agents that run tests: `./node_modules/.bin/*` directly (pnpm wrapper can fail), pipe long output through `tail`.
- **Prefer read-only agents** for search/audit/review. Grant write access only for a scoped edit task; use worktree isolation when parallel agents mutate files.
- **Verify before trusting.** When an agent removes or rewrites code, diff-check it didn't remove too much — this has happened here. Behavior claims from an agent need a file reference you can spot-check.
- **Agents never push, publish, comment on PRs, or run `pnpm publish`.** They return results; the top-level session (or the user) takes outward-facing actions.
- **Scout, then fan out.** For large sweeps, run one cheap scout to build the concrete work-list (files, routes, test titles), then parallelize over the list — not N agents each re-discovering scope.

## E2e: dev/prod bucketing

RULES:

- A build-fixture describe (`useFixture({ mode: "build" })`) MUST be titled `... (production)`; a dev-fixture describe must NOT contain `(production)`.
- Prefer the `prodDescribe(name, (f) => { ... })` helper (e.g. `tests/vite-rsc-demo/e2e/helper.ts`) — it generates the tag and wires the build fixture so the title can't drift. Use `f.url(...)`.
- A helper taking a `mode` variable (e.g. `defineSpec(label, mode)`) must itself couple `mode: "build"` with a `(production)` title — the static check can't tie a variable mode to a title.

Why: suites bucket dev vs production by grepping describe titles — `production` matches `(production)`, `dev` matches everything else. A mistitled production describe (`(prod)`, `-build` — both have happened) silently lands in the dev bucket and production coverage vanishes with no error. Guards: `pnpm check:e2e-bucketing` enforces (CI lint + pre-commit); `pnpm check:e2e-parity` reports dev describes lacking a `(production)` sibling and guard-blind variable-mode describes.

## E2e: running a subset locally

`--grep` alone balloons: (1) dependency projects run unfiltered — `production` depends on `dev` (~200 tests; measured 208 vs 1) — add **`--no-deps`**; (2) `--grep` is a regex, so `()`/`[]`/`?` in a pasted title silently mis-match — use a metacharacter-free title fragment.

- webServer-build suites (rangojs-router, cloudflare-basic): `pnpm exec playwright test --project=production --no-deps --grep "<fragment>"` — the webServer still builds/serves.
- Setup-project-build suites (vite-rsc-demo, no-typescript): `pnpm build` in the app first, then `--no-deps`.
- Match stable title fragments, not `file:line` — react-compiler apps report babel-transformed line numbers in `--list`.

## Userland test coverage

RULE: every consumer-touchable feature ships unit coverage **through the public `@rangojs/router/testing` primitives** (`renderHandler`, `runLoader`, `runMiddleware`, `renderRoute`, `dispatch`, `flight`) — in addition to internal unit tests and dev+prod e2e, not instead. Dogfood guarantee: if we can't test it with the primitives we hand consumers, neither can they.

- If a primitive can't reach the feature, **extend the primitive in the same PR** — wrap stubs with the same production wiring, don't fake methods. (Scar tissue: `renderHandler` stubbed `ctx.use` without production's `withDefer` wrapper, making `.defer()` unreachable from the harness; fix was wrapping the stub in `src/testing/render-handler.ts`.)
- Put the test where `test:unit:all` runs it: `packages/rangojs-router/src/testing/__tests__/` and/or a consumer dogfood suite (`packages/rangojs-router/e2e/mini/test/*`, `tests/cloudflare-basic/**`).

## Pull request descriptions

PRs tell the **consumer-side story** on top of the code change: what does a consumer write differently, see differently, and what happens if they don't adopt it. If the PR touches anything consumer-visible (public API, middleware semantics, error shapes, HTTP responses, generated types, DX defaults), show it from the consumer's seat — without trimming code-level detail. Chore/version-bump PRs exempt. Every non-trivial PR includes:

1. **Problem statement** — one paragraph, in consumer-observable terms ("miniflare returned an opaque 500 instead of the intended 302"), not call-site terms.
2. **Before vs. after usage example** — same snippet shape for both so the delta is obvious.
3. **One end-to-end consumer example** — realistic, copy-pasteable, not a toy.
4. **Semantics table when behavior branches** (return vs. throw, dev vs. prod, …), including cases deliberately left unchanged.
5. **Code-change summary** — files touched, shape of the diff (key block inline), why that location over alternatives.
6. **Test plan checklist** — unit + e2e (dev + production), typecheck, lint, format; name new tests and the contract each pins.
7. **Notes** — surprising interactions, migration implications, deferred follow-ups.

Reference template: PR #481 (`fix(router): throw Response from top-level middleware short-circuits`).

## Documentation voice (internal docs)

Internal docs read like a senior engineer onboarding a teammate — warm and direct, not a spec sheet. Exemplar: `packages/rangojs-router/docs/internal/matching-and-lazy-discovery.md`.

- Write to the reader ("you"); orient first, voice natural doubts and answer them.
- Lead with the why, then the mechanics.
- Non-obvious rules are scar tissue — say what broke.
- Warmth never replaces facts: keep file references, identifiers, tables, exact numbers. Warm ≠ chatty.
- No emoji, no marketing tone, no "honest"/"honestly".

Prose docs only — code comments stay terse (Coding guide).

## Internal reference docs

Keep in sync in the same PR whenever exports, files, or features change:

- `docs/README.md` — docs navigation hub.
- `docs/internal/feature-map.md` — export surface tables and capability inventory.
- `docs/internal/feature-file-map.md` — feature-to-source-file ownership map.
- `docs/why-rango.md` — consumer-facing positioning; hard bar: **nothing aspirational**. Every claim is shipped, source-verified behavior with a real-API snippet or greppable mechanism; in-progress features stay in `docs/design/`. Editing contract in the HTML comment at the top. `pnpm check:docs-api` (CI lint) verifies referenced identifiers still exist in src.

## Design documents

- `docs/design/caching.md` — segment-level runtime caching design.
- `packages/rangojs-router/docs/prerender-api-design.md` — pre-rendering design (canonical): prerender = build-time cache, B segment type, BuildContext, handler eviction, storage layout, passthrough mode, runtime flow.

**Pre-rendering rule**: pre-rendering is caching at build time. The worker handles every request — NO static .html/.rsc files served from assets. At runtime the worker looks up stored Flight payloads and feeds the segment system, identical to a cache hit; the browser can't tell a route was pre-rendered. Read the design doc before ANY pre-rendering change.

## Bundle hygiene

RULES:

1. **Generated route data lives in exactly ONE chunk** — the contract is lazy-only (`virtual:rsc-router/routes-manifest/<routerId>`, populated via `await ensureRouterManifest(routerId)` before matching). Never add `setRouteTrie`/`setPrecomputedEntries` to the eager manifest.
2. **Non-Cloudflare app vite configs MUST fold NODE_ENV for build**: `define: { "process.env.NODE_ENV": JSON.stringify("production") }`. Reference: `packages/rangojs-router/e2e/test-app/vite.config.ts`.

Why (tree-shaking can't catch either; both caused large regressions — commits `d10a2470`, `e56f2ee2`): (1) inlined `JSON.parse('<huge string>')` data in both an eager and a lazy chunk stays live in BOTH — each is side-effectful; (2) unfolded NODE_ENV makes the minifier keep React's dev AND prod branches, doubling its footprint. The Cloudflare vite plugin folds automatically; vanilla `vite build` folds client only, not SSR/RSC.

Guard: `packages/rangojs-router/e2e/build-test-app.setup.ts` fails any production build containing a `react*.development*.js` chunk. Analyzer: `RANGO_ANALYZE=1 pnpm exec vite build` in any wired app emits treemaps to `<app>/bundle-stats/{client,ssr,rsc}.html` (per-environment plugin instances via `applyToEnvironment` — don't collapse to one visualizer call).

**Rejected client-runtime optimizations** (don't redo without new information):

- `browser/server-action-bridge.ts` (~3.5 KB gzip) — lazy-loading adds a chunk fetch on first server-action call; actions are fundamental to almost every app.
- Theme modules (~3 KB) — FOUC prevention; the class must hit `<html>` before first paint, so any chunk fetch defeats it.
- `NavigationProvider.tsx` per-feature splitting (~1.9 KB) — feature gates are context-shape needed for types regardless; big API churn for <2 KB.
- `browser/partial-update.ts` (~2.8 KB) — used on every navigation and action response; no path improves cold-start.

Baselines: Rango client runtime ~50 KB gzip; React + RSC client ~115 KB gzip (react-dom 96K + react 5K + rsd-webpack-client 12K + scheduler 3K). Further reductions require architectural changes, not surgical edits.
