---
name: react-compiler
description: Enable the React Compiler in a Rango app the @vitejs/plugin-rsc way — a separate @rolldown/plugin-babel running reactCompilerPreset(), ordered after react() and before the plugin that supplies @vitejs/plugin-rsc. Use when a consumer wants to turn React Compiler on, hits the dead plugin-react v6 `react({ babel })` path, or is unsure why server components aren't being compiled.
argument-hint:
---

# React Compiler

React Compiler is **opt-in** in Rango. The plugin pipeline is fully compatible —
you just add one more plugin. The catch on a current Rango stack (Vite 8 +
`@vitejs/plugin-react` v6) is that **v6 dropped its internal Babel for oxc**, so
the way the React docs and most blog posts show it — `react({ babel: { plugins:
[...] } })` — silently does nothing. The compiler has to be its own top-level
plugin.

## The shape (read first)

- The compiler is a **Babel** plugin, run via
  [`@rolldown/plugin-babel`](https://www.npmjs.com/package/@rolldown/plugin-babel)
  with `reactCompilerPreset()` from `@vitejs/plugin-react`.
- **Ordering is load-bearing:** put `babel(...)` **after `react()`** and
  **before the plugin that supplies `@vitejs/plugin-rsc`**. In a default Rango
  app that plugin is `rango()` itself; in a Cloudflare app it is
  `@cloudflare/vite-plugin`.
- **It is client-only.** `reactCompilerPreset()` gates itself to the client
  environment. Server/RSC components are not compiled, and that is the upstream
  example's behavior — not a Rango limitation. See
  [What gets compiled](#what-gets-compiled-client-only).
- **Rango's build-time prerender is unaffected.** You do not need to do anything
  special. See [Prerender](#interaction-with-build-time-prerender).

## Step 1: Install

```bash
pnpm add -D @rolldown/plugin-babel @babel/core babel-plugin-react-compiler
# TypeScript users also want the Babel core types:
pnpm add -D @types/babel__core
```

React 19 ships `react/compiler-runtime` in-tree, so there is **no** extra runtime
to install and **no** `target` option to set. Only pass `target: '17' | '18'` to
`reactCompilerPreset()` if you are on an older React.

## Step 2: Wire it in

### Default (non-Cloudflare) app

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    rango(), // supplies @vitejs/plugin-rsc
  ],
});
```

### Cloudflare app

```ts
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    rango({ preset: "cloudflare" }),
    cloudflare({
      /* ... */
    }), // supplies @vitejs/plugin-rsc
  ],
});
```

## What gets compiled (client-only)

`reactCompilerPreset()` carries
`rolldown.applyToEnvironmentHook: (env) => env.config.consumer === "client"`, so
even though the babel plugin is top-level, the transform runs **only in the
`client` environment**:

| Environment | `consumer` | Compiled? |
| ----------- | ---------- | --------- |
| client      | `client`   | Yes       |
| ssr         | `server`   | No        |
| rsc         | `server`   | No        |

This matches the upstream `@vitejs/plugin-rsc` example. If you genuinely need to
compile **server** components, you would have to invoke
`babel-plugin-react-compiler` yourself without the preset's
`applyToEnvironmentHook` — that is outside what the example does and is not
covered here.

## Options

`reactCompilerPreset()` forwards to `babel-plugin-react-compiler`:

| Option                          | Effect                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `compilationMode: 'annotation'` | Compile only components marked with the `"use memo"` directive, not every eligible one |
| `target: '17' \| '18'`          | Emit `react-compiler-runtime` calls for React < 19. Omit on React 19+.                 |

## Interaction with build-time prerender

Nothing to configure. Rango's discovery/prerender step runs a throwaway temp Vite
server (`createTempRscServer`) that forwards only your **resolution** plugins
(`resolveId` / `load`). A pure transform plugin like `@rolldown/plugin-babel` is
intentionally **not** forwarded — and that is correct: the temp runner only
produces **data** (serialized Flight payloads + the route manifest), not shipped
code, and React Compiler is a memoization-only transform that does not change
rendered output. Your shipped client bundle still gets compiled, because the
babel plugin lives in your app's top-level plugin array alongside `react()`.

## Step 3: Verify the compiler actually ran

A compiled module imports the cache allocator from `react/compiler-runtime` and
calls `_c(n)`. Those two appear in **every** compiled module, so they are the
reliable per-module signal in dev:

```bash
pnpm dev
# fetch any client component module straight from Vite and look for the markers:
curl -s "http://localhost:5173/src/components/SomeClientComponent.tsx" \
  | grep -E "compiler-runtime|_c\("
```

For a production build, grep the built client bundle for the compiler's
input-independent cache check, which has a **zero baseline** without the compiler:

```bash
pnpm build
grep -r "Symbol.for(\"react.memo_cache_sentinel\")" dist/client/assets/ | head
```

Note the **comparison** form `$[i] === Symbol.for("react.memo_cache_sentinel")`
is only emitted for components with input-independent JSX, so it is reliable over
the **whole** client bundle, not necessarily in one chosen module. (React core
also defines that symbol once with a single `=` assignment, so count comparisons,
not the bare string.) Run the same grep over `dist/rsc` / `dist/ssr` and you
should find **none** — that is the client-only contract.

## Troubleshooting

| Symptom                                                               | Cause / fix                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing is compiled; no `compiler-runtime` import anywhere            | You used `react({ babel: { plugins: [...] } })`. plugin-react v6 has no internal Babel — add `@rolldown/plugin-babel` as its own plugin.    |
| Client compiled, but server/RSC components are not                    | Expected. `reactCompilerPreset()` is client-only (see the table). Not a bug.                                                                |
| `Cannot find module 'babel-plugin-react-compiler'` (or `@babel/core`) | Install the peer deps from Step 1; they are not bundled by `reactCompilerPreset()`.                                                         |
| Build pulls in `react-compiler-runtime`                               | You set `target: '17'`/`'18'` on React 19. Drop `target` — React 19 ships `react/compiler-runtime` in-tree.                                 |
| Output looks compiled but a component misbehaves                      | The component likely breaks the Rules of React. Fix the component, or scope the compiler with `compilationMode: 'annotation'` while you do. |

## Reference

A worked, tested wiring (dev + production e2e markers, incl. the client-only
contract) lives in the `@rangojs/router` repo: `docs/react-compiler.md` and the
`react-compiler.test.ts` files under `e2e/e2e-basic`, `tests/cloudflare-basic`,
and `tests/vite-rsc-demo`.
