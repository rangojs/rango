---
name: bundle-analysis
description: Audit production bundles across CF apps and e2e apps for server leaks, dev/prod React duplication, oversized chunks, and cross-env data duplication. Use when investigating bundle size regressions, before publishing a release, or when adding/changing public exports, the rango Vite plugin, or generated route data.
---

# Bundle Analysis

## When to run this skill

- Before publishing an experimental release (sanity check that nothing leaked).
- When a PR touches `packages/rangojs-router/src/vite/` (especially virtual-module codegen) or the public exports in `index.ts` / `index.rsc.ts` / `server.ts` / `client.tsx` / `cache/index.ts` / `host/index.ts` / `theme/index.ts`.
- When a new app is added under `tests/`, `examples/`, or `packages/rangojs-router/e2e/`.
- When chunk sizes look suspicious in a CI build summary.
- When a consumer reports a large client/SSR/RSC bundle.

## What it checks

The two failure modes that tree-shaking **cannot** catch (see `AGENTS.md` § Bundle Hygiene):

1. **Generated data duplicated across eager + lazy chunks.** Specifically the `virtual:rsc-router/routes-manifest` virtual module — the trie and precomputedEntries must live only in the lazy per-router chunk, not in the eager manifest.
2. **`process.env.NODE_ENV` not folded for SSR/RSC builds.** When unfolded, React's CJS files ship both `.development.js` and `.production.js` variants. The `build-test-app.setup.ts` setup test guards against this for test-app, but new vite configs need the explicit `define`.

Plus general hygiene: server code in client bundles, oversized chunks, suspicious cross-env duplication.

## Steps

### 1. Build the wired apps with the analyzer enabled

The analyzer is opt-in via `RANGO_ANALYZE=1`. Each wired app emits per-environment treemaps to `<app>/bundle-stats/{client,ssr,rsc}.html`.

Wired apps:

- `tests/cloudflare-basic`
- `tests/cloudflare-stress-demo`
- `examples/cloudflare-basic-nonce`
- `examples/cloudflare-multi-router`
- `packages/rangojs-router/e2e/test-app`
- `packages/rangojs-router/e2e/e2e-basic`

Build all of them (run from repo root):

```bash
for app in tests/cloudflare-basic tests/cloudflare-stress-demo examples/cloudflare-basic-nonce examples/cloudflare-multi-router packages/rangojs-router/e2e/test-app packages/rangojs-router/e2e/e2e-basic; do
  (cd "$app" && rm -rf dist bundle-stats && RANGO_ANALYZE=1 pnpm exec vite build > /dev/null 2>&1)
  echo "$app done"
done
```

Or build a single app:

```bash
cd tests/cloudflare-basic && rm -rf dist bundle-stats && RANGO_ANALYZE=1 pnpm exec vite build
```

Note: after editing router Vite plugin code (`packages/rangojs-router/src/vite/`), rebuild the router first: `pnpm build-router`.

### 2. Run the programmatic report

From the repo root:

```bash
node tools/bundle-report.mjs
```

Pipe to a file or `less` if it's long. The report has 7 sections; the most important are #1 (totals), #2 (server-leak audit), and #6 (stress-demo route-manifest sanity).

### 3. Triage the report

Look for these signals:

- **Section 2 ("Server-only modules in CLIENT")**:
  - "REAL LEAK" with non-zero gzip → server code is shipping to client. Trace via the visualizer report.
  - "tree-shaken stubs" entries are fine (0 bytes) but ideally cleaned up by tightening exports.
- **Section 6 (RSC drilldown for stress-demo)**:
  - `virtual:rsc-router/routes-manifest` should be **tiny** (< 1 KB). If it's > 100 KB, the eager manifest is inlining trie/precomputedEntries again.
  - The lazy `virtual:rsc-router/routes-manifest/<hash>` chunk holds the actual data — that's expected.
- **Section 5 (SSR drilldown)**: any `react*.development*.js` chunk in any app's SSR is a regression. The setup test `build-test-app.setup.ts` should already have failed; if it didn't, the test pattern needs broadening.
- **Section 3 (cross-env duplication)**: small files in all 3 envs are normal; large files (> 5 KB triple-bundled) deserve a look.
- **Section 4 (router chunk breakdown)**: should be 50–60 KB gzip across CF apps. A jump > 10 KB versus the baseline means new client runtime code crept in.

### 4. Inspect the visualizer treemaps for context

When the programmatic report flags something, open the relevant HTML in a browser. They are file:// URLs, but Chrome rejects `file://` for local dev tooling — use a quick HTTP server:

```bash
pnpm dlx serve -l 5050 .
# Then open: http://localhost:5050/<app>/bundle-stats/<env>.html
```

Reports of interest:

- `tests/cloudflare-basic/bundle-stats/client.html` — baseline client.
- `examples/cloudflare-multi-router/bundle-stats/client.html` — multi-app, look at the per-app `handler-*.js` chunks.
- `tests/cloudflare-stress-demo/bundle-stats/rsc.html` — manifest sanity (look for `routes-manifest` + `routes-manifest/<hash>`).
- `packages/rangojs-router/e2e/test-app/bundle-stats/ssr.html` — biggest e2e SSR.

### 5. If nothing is wrong, document the run

When this skill finishes a clean run (no leaks, no doubled manifest, no dev React in SSR), don't write a doc — just say so in the chat. Memory rules forbid "everything was fine" docs. Only write when there's a finding worth tracking.

## Output expectations

When invoked, this skill produces:

1. A **headline verdict**: clean / has-finding.
2. The **stress-demo eager-manifest size** (specific number to track over time — should be < 1 KB).
3. The **per-app baseline** in a markdown table (matches Section 1 of the report).
4. Any **flagged anomalies** with byte numbers and the file paths involved.

Do NOT:

- Re-run the full e2e suite. The unit tests + the bundle guard in `build-test-app.setup.ts` cover regression.
- Commit `dist/` or `bundle-stats/` — both are gitignored.
- Modify the helper at `tools/bundle-analyze.ts` without testing all 3 envs (it has a per-env `applyToEnvironment` scoping that's easy to break).

## Reference

- Helper plugin: `tools/bundle-analyze.ts`
- Report script: `tools/bundle-report.mjs`
- Bundle guard test: `packages/rangojs-router/e2e/build-test-app.setup.ts`
- Rules of thumb: `AGENTS.md` § "Bundle Hygiene"
- Reference fixes: commits `d10a2470` (manifest dedup, –219 K stress-demo RSC) and `e56f2ee2` (NODE_ENV fold, –58 % e2e SSR).
