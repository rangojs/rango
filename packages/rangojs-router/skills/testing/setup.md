# Testing setup — the two vitest projects

**Layer:** cross-cutting (vitest config) · **Import:** `@rangojs/router/testing/vitest`

Real machinery: Vite transpiles `@rangojs/router`'s shipped TS source and resolves the bare specifier to its react-server impls so your app's router / loaders / middleware import in a bare Vitest process. You SEED nothing here — this file only wires the two projects every other recipe builds on. The node/DOM project keeps React on its CLIENT build; the Flight project flips to the `react-server` condition.

## API

### Options — `RangoTestAliasOptions`

| Field    | Type                     | Meaning                                                                                                                                                                                                                                                                                      |
| -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preset` | `"node" \| "cloudflare"` | Deployment preset, matching `rango({ preset })` in the Vite plugin. `"cloudflare"` additionally stubs the `cloudflare:workers` / `cloudflare:email` runtime virtuals a CF route tree imports. A string (not a boolean) so more presets can be added without an API change. Default `"node"`. |

### Functions

| Function                    | Returns                                   | Use                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rangoTestConfig(opts?)`    | `{ alias, server: { deps: { inline } } }` | Recommended. Spread into the node/DOM project's `test` block. Bundles the resolve aliases AND `server.deps.inline`.                                                                                         |
| `rangoTestAliases(opts?)`   | `TestAlias[]` (`{ find, replacement }[]`) | Lower-level. The bare `@rangojs/router` -> `index.rsc.ts` alias plus the `:version` / `@vitejs/plugin-rsc/rsc` stubs (and CF stubs under `preset:"cloudflare"`). Used in the rsc project's `resolve.alias`. |
| `rangoUseClientTransform()` | a Vite plugin (`{ name, transform }`)     | Add to the rsc project `plugins`. Applies the `"use client"` transform so `renderServerTree` auto-discovers client islands from the server tree's imports.                                                  |

### Returns — `RangoTestConfig` (from `rangoTestConfig`)

```ts
interface RangoTestConfig {
  alias: TestAlias[]; // -> test.alias
  server: { deps: { inline: RegExp[] } }; // [/@rangojs[/\\]router/] -> test.server.deps.inline
}
```

## Recipe

```ts
// vitest.config.ts — the node + DOM project (keeps React on its CLIENT build)
import { defineConfig } from "vitest/config";
import { rangoTestConfig } from "@rangojs/router/testing/vitest";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node", // renderRoute tests add a `// @vitest-environment happy-dom` pragma
    // `preset: "cloudflare"` also stubs cloudflare:workers / cloudflare:email (default "node").
    ...rangoTestConfig({ preset: "cloudflare" }),
  },
});
```

```ts
// vitest.rsc.config.ts — the Flight project (react-server condition)
import { defineConfig } from "vitest/config";
import {
  rangoTestAliases,
  rangoUseClientTransform,
} from "@rangojs/router/testing/vitest";

// Production React in this process AND any forked worker (forks inherit env).
process.env.NODE_ENV = "production";

export default defineConfig({
  plugins: [rangoUseClientTransform()],
  resolve: {
    conditions: ["react-server"],
    alias: rangoTestAliases({ preset: "cloudflare" }), // or { preset: "node" }
  },
  test: {
    globals: true,
    include: ["**/*.rsc-test.{ts,tsx}"],
    pool: "forks",
    execArgv: ["--conditions=react-server"], // or React throws "react-server condition must be enabled"
  },
});
```

```ts
// example.test.ts — one test in the node/DOM project, importing real app code
import { describe, it, expect } from "vitest";
import { dispatch } from "@rangojs/router/testing";
import { createRouter } from "@rangojs/router";
import { apiPatterns } from "../src/api/urls"; // path.json(...) routes only, no Prerender()

const router = createRouter().routes(apiPatterns);

describe("api", () => {
  it("serializes a JSON response route", async () => {
    const res = await dispatch(router, { request: "/health" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
```

Scripts:

```jsonc
{
  "scripts": {
    "test:unit": "vitest run",
    "test:unit:rsc": "vitest run --config vitest.rsc.config.ts",
  },
}
```

## Caveats

- Node >= 23 requires `rangoTestConfig()`, not bare `rangoTestAliases()`. `@rangojs/router` is consumed as SOURCE (exports -> `./src/*.ts`), and Node >= 23 refuses to type-strip `.ts` under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). `rangoTestConfig` ships as compiled JS AND adds `server.deps.inline: [/@rangojs[/\\]router/]` so Vite (not Node) transpiles rango source. With bare `rangoTestAliases` you must wire `deps.inline` yourself.
- Two separate projects. The node/DOM project keeps React on its CLIENT build; the Flight project uses the `react-server` condition in a separate `vitest.rsc.config.ts`. The main project must NOT set `react-server` — it flips React to the no-hooks server build and breaks every `renderRoute` / client test.
- The rsc project needs BOTH `resolve.conditions: ["react-server"]` AND the bare `@rangojs/router` -> `index.rsc.ts` alias from `rangoTestAliases({ preset })`. `resolve.conditions` alone is not reliably applied to bare-package export resolution; without the alias a handler/component reading `getRequestContext()` / `cookies()` resolves the throwing out-of-react-server stub (symptom: `renderHandler` returns `tree: undefined`).
- `NODE_ENV` must be `"production"` in the rsc project. Dev `NODE_ENV` crashes the bare worker (jsxDEV owner-stack machinery uninitialized) and emits volatile debug rows that defeat stable Flight snapshots.
- The forked rsc worker (`pool: "forks"`) must force the condition via `execArgv: ["--conditions=react-server"]`, or React throws "the react-server condition must be enabled".
- The `@rangojs/router:version` and `@vitejs/plugin-rsc/rsc` virtuals must be stubbed; the preset does it. A bare router import without stubbing throws.
- The rango fragment goes under `test` (`test.alias` + `test.server.deps.inline`, both returned by `rangoTestConfig`), NOT under top-level `resolve`.
- Wire `rangoUseClientTransform()` into the rsc project `plugins` so islands auto-discover from the server tree imports (see `./server-tree.md`); without it, register islands explicitly with `clientComponents`.

## See also

- (cross-cutting)
- Siblings: `./flight.md`, `./server-tree.md`, `./render-handler.md`, `./response-routes.md`
- Long-form prose: [docs/testing.md](https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/testing.md) — section "Setup" (and the subsections "Resolving @rangojs/router in a unit test — use the preset" and "Two vitest projects")
