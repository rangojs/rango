# React Compiler

If you want the React Compiler's automatic memoization in a Rango app, there is
almost nothing Rango-specific to learn: it is one option on `@vitejs/plugin-react`,
with one boundary worth knowing (it compiles client components, not RSC).

The compiler is **opt-in** — Rango does not enable it for you — but the plugin
pipeline is fully compatible. `@vitejs/plugin-react` 6.1 ships a native React
Compiler behind `react({ compiler: true })`, backed by
[`oxc-transform-react`](https://www.npmjs.com/package/oxc-transform-react),
Oxc's Rust port of the compiler. No Babel, no extra plugin, no ordering rules.
Upstream marks the option experimental; the previous Babel wiring still works and
is kept below as the [fallback](#babel-fallback).

## How it runs

With `compiler` on, plugin-react adds a `vite:react-compiler` transform
(`enforce: "pre"`) that hands each matching module to `oxc-transform-react` in one
pass: React Compiler first, on the pristine AST, then TypeScript removal, the JSX
transform and Fast Refresh. plugin-react turns its own oxc JSX refresh injection
off while the option is on, so nothing is emitted twice and `jsxDEV` line numbers
still point at your source. Vite's regular `vite:oxc` transform still runs
afterwards for target lowering; it finds no JSX or TypeScript left.

The transform runs in every environment, but the compiler and Fast Refresh only
apply where `environment.config.consumer !== "server"`. Server environments get
the TypeScript/JSX pass only.

## What gets compiled (client-only)

| Environment | `consumer` | Compiled? |
| ----------- | ---------- | --------- |
| client      | `client`   | Yes       |
| ssr         | `server`   | No        |
| rsc         | `server`   | No        |

This is plugin-react's contract, not a Rango limitation. If you need to compile
server components you would have to run `babel-plugin-react-compiler` yourself;
that is outside what is covered here.

## Install

```sh
pnpm add -D oxc-transform-react@^0.145.0
```

Take the range from `@vitejs/plugin-react`'s `peerDependencies` (`^0.145.0` for
6.1.x) rather than npm's latest. `oxc-transform-react` cuts a new minor every
couple of weeks and plugin-react widens its range in its own releases, so a newer
binding shows up as an unmet-peer warning under pnpm and an `ERESOLVE` error under
npm (vitejs/vite-plugin-react#1437). This repo pins the range in the
`pnpm-workspace.yaml` catalog; bump both together.

React 19 ships `react/compiler-runtime` in-tree, so no `react-compiler-runtime`
shim and no `target` option are needed. Set `target: '17' | '18'` only on an older
React.

## Default (non-Cloudflare) app

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [react({ compiler: true }), rango()],
});
```

## Cloudflare app

```ts
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [
    react({ compiler: true }),
    rango({ preset: "cloudflare" }),
    cloudflare({
      /* ... */
    }),
  ],
});
```

Both layouts keep `react()` ahead of `rango()` / `cloudflare()`, which is what the
e2e apps run.

## Options

`compiler` takes `true` or the React Compiler configuration plus one plugin-level
flag:

| Option                          | Effect                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `compilationMode: 'annotation'` | Compile only components marked with the `"use memo"` directive, instead of every eligible component.                                           |
| `target: '17' \| '18'`          | Emit `react-compiler-runtime` calls for React < 19. Omit on React 19+.                                                                         |
| `logDiagnostics: true`          | Log recoverable compiler diagnostics (why a component was skipped) through Vite. Default `false`. Fatal diagnostics always fail the transform. |

`logDiagnostics` can only relay what the binding reports. `oxc-transform-react`
0.145.x, the range plugin-react 6.1 declares, reports bail-out reasons. 0.148.0
dropped them (oxc-project/oxc#26318), so the flag goes silent once plugin-react's
peer range moves past it; 0.146 and 0.147 still report but need a later
plugin-react. Callback-valued Babel
options (`logger`, function-valued `sources`) do not exist on the native path;
`sources` takes an array of filename substrings.

## Interaction with build-time prerender

Rango's discovery / prerender step runs a throwaway temp Vite server
(`createTempRscServer` in `src/vite/router-discovery.ts`) that forwards only your
_resolution_ plugins (`resolveId` / `load`) and denies every `vite:*` plugin
(`selectForwardableResolvePlugins` in `src/vite/utils/forward-user-plugins.ts`),
so `vite:react-compiler` never runs there. That is correct: the temp runner only
produces **data** (serialized Flight payloads and the route manifest), not shipped
code, and React Compiler is a memoization-only transform that does not change
rendered output. Your shipped **client** bundle is compiled by the
`react({ compiler: true })` in your app's own plugin array.

## Verifying the compiler ran

The native compiler emits the same shape as `babel-plugin-react-compiler`. A
compiled module imports the allocator,
`import { c as _c } from "react/compiler-runtime"`, and calls `_c(n)`; a compiled
component seeds each memo-cache slot with `Symbol.for("react.memo_cache_sentinel")`
and reads it back with a strict comparison,
`$[i] === Symbol.for("react.memo_cache_sentinel")`. That triple-`=` comparison
form appears only in compiled output (React core's lone sentinel _definition_
uses a single `=`), so grepping a built client chunk for
`=== Symbol.for("react.memo_cache_sentinel")` is a reliable signal. The same grep
over the `rsc`/`ssr` bundles returns nothing, which is how the tests pin the
client-only contract. In dev, a compiled module also carries Fast Refresh's
`$RefreshReg$(...)` registration, which pins that the native pass still emits
refresh. See `e2e/react-compiler.test.ts` (e2e-basic),
`tests/vite-rsc-demo/e2e/react-compiler.test.ts` and
`tests/cloudflare-basic/e2e/react-compiler.test.ts` for the dev + production
checks.

Output is not byte-identical to Babel's: the port tracks React's experimental
compiler channel, so a handful of components memoize a different number of
values, and comments inside a compiled function body are dropped. Neither changes
rendered output.

## Babel fallback

On `@vitejs/plugin-react` < 6.1, or if you need a Babel-only compiler option, the
previous wiring still works: a top-level
[`@rolldown/plugin-babel`](https://www.npmjs.com/package/@rolldown/plugin-babel)
running `reactCompilerPreset()` from `@vitejs/plugin-react`, placed after
`react()` and before the plugin that supplies `@vitejs/plugin-rsc`. The preset
gates itself to `consumer === "client"`, so the client-only contract is the same.
Do not combine it with `compiler: true`.

```sh
pnpm add -D @rolldown/plugin-babel @babel/core babel-plugin-react-compiler @types/babel__core
```

```ts
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

// plugins: [react(), babel({ presets: [reactCompilerPreset()] }), rango()]
```
