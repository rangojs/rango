---
name: bundle-analysis
description: Audit a Rango app's production bundle for server-side code leaking into the client, dev/prod React duplication, oversized chunks, and inefficient client-reference grouping. Use when investigating bundle size growth, before a production deploy, or when the client/SSR/RSC output suddenly balloons.
argument-hint: "<app-dir>"
---

# Bundle Analysis

Use this when you want **proof** that your Rango app is shipping the bundles you expect: small client, no server leaks, no doubled React, reasonable RSC worker size.

## What this checks

Your app builds in three Vite environments — `client`, `ssr`, and `rsc` — and each ships its own bundle. The most common bundle bugs in a Rango app are:

1. **Server code leaking into the client.** A file that imports `node:fs`, calls a database, or contains action logic ends up in the client bundle because a client component pulled it in transitively. Symptom: your client bundle is much larger than expected, sometimes with imports that fail at runtime.
2. **Both dev and prod React in the SSR/RSC bundle.** When `process.env.NODE_ENV` isn't folded at build time, React's CJS files ship both `.development.js` _and_ `.production.js` variants — doubling React's footprint. The Cloudflare vite plugin folds NODE_ENV automatically; vanilla `vite build` does it for client but not always for SSR/RSC.
3. **An oversized routes-manifest in your RSC worker.** The `virtual:rsc-router/routes-manifest/<routerId>` chunk holds your route trie and precomputed entries — large only in proportion to your route count. If it's surprisingly big, you may have unintentionally generated routes (e.g., parametrized fixtures) that bloated the trie.
4. **Inefficient client-reference grouping.** Each `"use client"` boundary becomes a chunk. Too many small client components = many tiny chunks; one giant client component = one giant chunk that defeats code-splitting.

Tree-shaking does _not_ catch (1) generated data inlined as string literals or (2) data-dependent conditionals like React's. You need a visualizer.

## Step 1: Install the visualizer

In your app's directory:

```bash
pnpm add -D rollup-plugin-visualizer
# or: npm install --save-dev rollup-plugin-visualizer
# or: yarn add -D rollup-plugin-visualizer
```

## Step 2: Wire it into your `vite.config.ts`

Add a small helper that registers one visualizer instance **per Vite environment** (not just one global). The plugin caches its options after the first call, so a single instance can't handle multi-environment builds — you'll get a report for one environment and silence for the others.

```ts
// vite.config.ts
import { defineConfig, type PluginOption, type Plugin } from "vite";
import { visualizer } from "rollup-plugin-visualizer";
import { join } from "node:path";
// ... your other imports ...

function analyze(): PluginOption[] {
  if (!process.env.RANGO_ANALYZE) return [];
  return (["client", "ssr", "rsc"] as const).map((envName) => {
    const inner = visualizer({
      filename: join("bundle-stats", `${envName}.html`),
      template: "treemap",
      gzipSize: true,
      brotliSize: true,
    }) as Plugin;
    return {
      ...inner,
      name: `analyze-${envName}`,
      applyToEnvironment(env) {
        return env.name === envName;
      },
    } as Plugin;
  });
}

export default defineConfig(({ command }) => ({
  plugins: [
    // your existing plugins...
    ...analyze(),
  ],
  // For non-Cloudflare apps, fold NODE_ENV explicitly so React's CJS files
  // emit only the .production.js variants in SSR/RSC. Skip if your build
  // setup already does this (the Cloudflare vite plugin does).
  define:
    command === "build"
      ? { "process.env.NODE_ENV": JSON.stringify("production") }
      : undefined,
}));
```

Add `bundle-stats/` to your `.gitignore`.

## Step 3: Build with the analyzer enabled

```bash
RANGO_ANALYZE=1 pnpm exec vite build
```

You'll get three HTML reports in `bundle-stats/`:

- `bundle-stats/client.html` — what runs in the browser
- `bundle-stats/ssr.html` — what runs during HTML stream
- `bundle-stats/rsc.html` — what runs in your RSC server (Worker / Node)

Open them with a quick local server (file:// has CORS issues with the embedded scripts):

```bash
pnpm dlx serve -l 5050 .
# then visit http://localhost:5050/bundle-stats/client.html
```

## Step 4: Triage the reports

### Open `client.html` first

The treemap shows nested boxes; box area = uncompressed size. Hover for gzip/brotli numbers.

**Look for:**

- **Your server code.** Any of your own files that contain database queries, secret keys, server actions implementation (not the action _reference_), or `node:` imports. If they appear in the client treemap with non-zero bytes, they leaked. Common causes:
  - A shared module that mixes client and server code without a `"use client"` or `"use server"` directive.
  - A barrel file (`index.ts`) that re-exports both client and server symbols. Tree-shaking should help, but `JSON.parse('{...}')` data and side-effecting top-level statements survive.
  - Client component imports a server-only utility through an indirect path (e.g., shared types file that pulls server modules).
- **Multiple copies of the same package.** Look for two boxes with the same package name but different version paths. Usually means a transitive dep pinned a different version.
- **The `@rangojs/router` chunk** should be roughly **50 KB gzip** (74 files). If significantly larger, you might be importing client-incompatible APIs from the wrong subpath.
- **Per-route client-reference chunks** (named like `chunk-<hash>.js`). Each `"use client"` boundary can become its own chunk. If you have hundreds of tiny chunks, you may have over-split (every leaf component as a client component); if you have one massive 200 KB chunk, you've under-split (a wide client tree behind one boundary).

### Now check `ssr.html`

**Look for:**

- **`react-dom-server.edge.development-*.js`** (or any `*.development*.js` chunk). This is the dev/prod React doubling. Fix: add `define: { "process.env.NODE_ENV": '"production"' }` to your vite config (see Step 2).
- **Your client components** appearing in SSR. They're _expected_ here — SSR hydration needs to produce HTML for them. The same components show up in `client.html` too because the browser hydrates them. This is not a leak.
- **Total SSR size**: a reasonable Rango SSR is ~140 KB gzip plus your app code. If it's >300 KB, almost always (1) dev/prod React duplication or (2) a giant data structure being inlined.

### Now check `rsc.html`

**Look for:**

- **`virtual:rsc-router/routes-manifest`** should be **tiny** (< 1 KB). If it's > 100 KB, you're on an old version of `@rangojs/router` that inlined the trie eagerly — upgrade to a release that includes commit `d10a2470`.
- **`virtual:rsc-router/routes-manifest/<hash>`** is the lazy per-router chunk. Its size is proportional to your route count. For a typical app: 5–50 KB gzip. For a stress-test app with thousands of routes: hundreds of KB. If yours is unexpectedly huge, check whether you're generating routes you don't need.
- **`<your-router>.named-routes.gen.ts`** — generated route map. Should match your route count.
- **Your action and loader implementations** — these run server-side. Expected to be here, not in client.
- **Worker-incompatible code** (Node-only imports like `node:fs` that Cloudflare doesn't support). The build will usually fail before the analyzer runs, but if you're seeing runtime errors at the edge, the RSC treemap shows what made it in.

## Step 5: Fix what you find

| Finding                                                  | Fix                                                                                                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your server code in `client.html` (non-zero bytes)       | Audit the import chain. Add `"use server"` to server-only files. Move shared data out of barrel files. Use the `@rangojs/router/server` subpath for explicitly server APIs. |
| Your server code in `client.html` listed but 0 bytes     | Tree-shaking already eliminated it. Cosmetic. Leave it.                                                                                                                     |
| `react-dom-server.edge.development-*.js` in SSR or RSC   | Add the `define` block from Step 2 to your vite config.                                                                                                                     |
| Routes-manifest > 100 KB gzip in RSC eager chunk         | Update `@rangojs/router` to a release that includes the lazy-only manifest fix.                                                                                             |
| Same package version present twice                       | Run `pnpm dedupe` (or `npm dedupe`). If the duplication persists, a transitive dep pins an incompatible version — open a PR upstream or pin the resolution.                 |
| Client chunk > 500 KB gzip with a single dominant module | That module is your largest client component. Consider lazy-loading via dynamic `import()` or moving non-interactive parts to server components.                            |
| Hundreds of tiny client chunks                           | You've sprinkled `"use client"` too liberally. Hoist directives to higher boundaries so React groups them.                                                                  |

## When to re-run

- Before every production deploy, especially after adding new dependencies.
- After upgrading `@rangojs/router`, React, or `@vitejs/plugin-rsc`.
- After adding routes that scale with data (e.g., one route per item from a content directory) — the manifest may have grown.
- When CI starts reporting larger artifact sizes.

## Reporting Rango regressions

If a finding looks like a `@rangojs/router` regression (the framework is shipping more than it should, not your app), open an issue at the [@rangojs/router GitHub](https://github.com/rangojs/rango/issues) and include:

- The output of `client.html` / `rsc.html` (screenshots or the JSON `data = {...}` block from the HTML).
- The `@rangojs/router` version (`pnpm why @rangojs/router`).
- Your `vite.config.ts`.

The framework maintainers run a similar audit internally — the methodology in this skill mirrors what they use to validate every release.
