---
name: prepare
description: Run checks, detect public API changes, and suggest skill/doc updates
---

# Prepare

## Step 1: Run all checks in parallel

Run all four commands concurrently from the repo root using the Bash tool:

1. `pnpm run format` (format check)
2. `pnpm run typecheck` (typecheck)
3. `pnpm run lint` (lint)
4. `pnpm run test:unit` (unit tests)

If any check fails, report the failures clearly and fix them before continuing.

## Step 2: Detect public API changes

Run `git diff HEAD` (or `git diff --cached` if changes are staged) and check whether any of these public API surface files were modified:

- `packages/rangojs-router/src/index.ts`
- `packages/rangojs-router/src/index.rsc.ts`
- `packages/rangojs-router/src/server.ts`
- `packages/rangojs-router/src/client.tsx` / `src/client.rsc.tsx`
- `packages/rangojs-router/src/cache/index.ts`
- `packages/rangojs-router/src/host/index.ts`
- `packages/rangojs-router/src/theme/index.ts`
- `packages/rangojs-router/src/build/index.ts`
- `packages/rangojs-router/src/rsc/index.ts`
- `packages/rangojs-router/src/ssr/index.tsx`
- `packages/rangojs-router/src/browser/index.ts`
- `packages/rangojs-router/package.json` (the `exports` field)

If any of these files have changes to exported symbols (new exports, renamed exports, removed exports, changed signatures), flag it clearly:

> **Public API changed**: list the specific changes (added/removed/renamed exports, signature changes).

Then check whether the corresponding **skills** in `packages/rangojs-router/skills/` or **docs** in `packages/rangojs-router/docs/` and `docs/` need updating to reflect the API change. Report which skill or doc files are potentially affected and what might need updating. Do NOT auto-edit skills or docs — just report the findings.

If no public API files were modified, report: "No public API changes detected."

## Step 3: Semantic matrix gate

Check whether the diff touches any semantic-critical files:

- `packages/rangojs-router/src/router/segment-resolution/**`
- `packages/rangojs-router/src/router/middleware/**`
- `packages/rangojs-router/src/router/action/**`
- `packages/rangojs-router/src/router/intercept/**`
- `packages/rangojs-router/src/router/revalidation/**`
- `packages/rangojs-router/src/router/prerender/**`
- `packages/rangojs-router/e2e/test-app/src/urls/**`
- `packages/rangojs-router/e2e/test-app/src/loaders.tsx`
- `packages/rangojs-router/e2e/test-app/src/router.tsx`
- `packages/rangojs-router/docs/internal/execution-model.md`
- `packages/rangojs-router/skills/middleware/SKILL.md`
- `packages/rangojs-router/skills/layout/SKILL.md`
- `packages/rangojs-router/skills/parallel/SKILL.md`
- `packages/rangojs-router/skills/intercept/SKILL.md`

If any of these files are modified, run the semantic matrix tests in both dev and production:

```bash
cd packages/rangojs-router && pnpm exec playwright test semantic-matrix
```

All rows must pass. If any fail, report them and fix before continuing.

If none of those files are modified, skip this step and report: "No semantic-critical changes detected — skipping matrix."

## Step 4: Review internal reference docs

Check whether the diff touches any files that would require updates to the internal reference docs:

- **Export surface changes** (new/removed/renamed exports, new subpath exports, `package.json` `exports` field changes) → update `packages/rangojs-router/docs/internal/feature-map.md` export surface tables
- **New features, hooks, DSL primitives, or architectural changes** → update the capability sections in `packages/rangojs-router/docs/internal/feature-map.md`
- **Source files added, removed, or renamed** → update `packages/rangojs-router/docs/internal/feature-file-map.md`
- **Doc files added or removed** in `packages/rangojs-router/docs/` → update `packages/rangojs-router/docs/README.md`

Read the current content of the affected doc(s) and compare against the diff. Report any entries that are now stale or missing:

> **Internal docs out of sync**: list specific stale/missing entries and which doc file needs updating.

If nothing needs updating, report: "Internal reference docs are up to date."

Do NOT auto-edit these docs — just report the findings so they can be addressed before merging.

## Step 5: Suggest /simplify if appropriate

Look at the diff from Step 2. If the changes include non-trivial new or modified code (not just config, formatting, or test-only changes), suggest running `/simplify` to review the changed code for reuse, quality, and efficiency. Phrase it as a suggestion, e.g.:

> **Suggestion**: The changes include new implementation code. Consider running `/simplify` to review for reuse, quality, and efficiency.

Skip this suggestion for trivial changes (formatting-only, config tweaks, test-only changes, doc-only changes).
