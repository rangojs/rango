# React Compiler

Rango supports the [React Compiler](https://react.dev/learn/react-compiler) the
same way the upstream `@vitejs/plugin-rsc` example does. The compiler is **opt-in**
— Rango does not enable it for you — but the plugin pipeline is fully compatible.
As in the upstream example, `reactCompilerPreset()` compiles your **client**
components; server/RSC components are left untouched (see
[scope](#what-gets-compiled-client-only) below).

## Why it is a separate plugin

`@vitejs/plugin-react` v6 (the version Rango targets, on Vite 8) runs **oxc** and
no longer bundles Babel internally, so the old `react({ babel: { plugins: [...] } })`
path is gone. The React Compiler is a Babel plugin, so it is wired as its own
top-level [`@rolldown/plugin-babel`](https://www.npmjs.com/package/@rolldown/plugin-babel)
running `reactCompilerPreset()` from `@vitejs/plugin-react`.

Ordering matters: the babel plugin goes **after `react()`** and **before** the
plugin that supplies `@vitejs/plugin-rsc`. For the default (non-Cloudflare) preset
that plugin is `rango()` itself; for the `cloudflare` preset it is
`@cloudflare/vite-plugin`.

## What gets compiled (client-only)

`reactCompilerPreset()` carries
`rolldown.applyToEnvironmentHook: (env) => env.config.consumer === "client"`, so
even though the babel plugin sits at the top level, the transform runs **only in
the `client` environment**. The `ssr` and `rsc` environments have
`consumer === "server"`, so server/RSC components are **not** compiled. This is the
upstream example's behavior, not a Rango limitation. If you need to compile server
components too, you would have to invoke `babel-plugin-react-compiler` yourself
without the preset's environment filter — that is outside what the example does and
is not covered here.

## Install

```sh
pnpm add -D @rolldown/plugin-babel @babel/core babel-plugin-react-compiler
# TypeScript users also want the Babel core types:
pnpm add -D @types/babel__core
```

React 19 ships `react/compiler-runtime` in-tree, so no `react-compiler-runtime`
shim and no `target` option are needed. Set `target: '17' | '18'` on
`reactCompilerPreset()` only if you are on an older React.

## Default (non-Cloudflare) app

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

## Cloudflare app

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

## Options

`reactCompilerPreset()` forwards to `babel-plugin-react-compiler`. Useful options:

| Option                          | Effect                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `compilationMode: 'annotation'` | Compile only components marked with the `"use memo"` directive, instead of every eligible component. |
| `target: '17' \| '18'`          | Emit `react-compiler-runtime` calls for React < 19. Omit on React 19+.                               |

## Interaction with build-time prerender

Rango's discovery / prerender step runs a throwaway temp Vite server
(`createTempRscServer` in `src/vite/router-discovery.ts`) that forwards only your
_resolution_ plugins (`resolveId` / `load`). A pure transform plugin like
`@rolldown/plugin-babel` is intentionally **not** forwarded — and that is correct.
The temp runner only produces **data** (serialized Flight payloads and the route
manifest), not shipped code, and the React Compiler is a memoization-only transform
that does not change rendered output. Your shipped **client** bundle still gets
compiled, because the babel plugin lives in your app's top-level plugin array
alongside `react()` (the preset's `applyToEnvironmentHook` scopes the work to the
client build, as described above).

## Verifying the compiler ran

A compiled component seeds each memo-cache slot with
`Symbol.for("react.memo_cache_sentinel")` and reads it back with a strict
comparison, `$[i] === Symbol.for("react.memo_cache_sentinel")`. That triple-`=`
comparison form appears only in compiled output (React core's lone sentinel
_definition_ uses a single `=`), so grepping a built client chunk — or a
dev-transformed module — for `=== Symbol.for("react.memo_cache_sentinel")` is a
reliable signal. The same grep over the `rsc`/`ssr` bundles returns nothing, which
is how the tests pin the client-only contract. See `e2e/react-compiler.test.ts`
(e2e-basic) and `tests/cloudflare-basic/e2e/react-compiler.test.ts` for the dev +
production checks.
