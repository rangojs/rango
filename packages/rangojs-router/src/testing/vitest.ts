/**
 * @rangojs/router/testing/vitest
 *
 * Vitest setup helper for the UNIT + INTEGRATION + DOM test project of a
 * @rangojs/router consumer app. It returns the `resolve.alias` entries that make
 * a real app's router / loaders / middleware importable in a bare Vitest process.
 *
 * Why this is needed (the documented "vi.mock(plugin-rsc) + import router"
 * recipe is not sufficient for a real app):
 *
 * - `@rangojs/router` resolves to SERVER-ONLY STUBS outside the `react-server`
 *   condition — `urls()`, `createRouter()`, `cookies()`, `getRequestContext()`
 *   throw "only available in a react-server environment". Importing the app's own
 *   router/loaders/middleware then fails immediately. Vitest does NOT apply the
 *   `react-server` condition to bare-package exports resolution, and enabling it
 *   globally flips React to its server build (no `createContext`), crashing the
 *   router's client-boundary imports. The surgical fix is to alias ONLY the bare
 *   `@rangojs/router` specifier to its react-server entry (real impls) while
 *   leaving React as the client build — which is exactly what this helper does.
 * - The build-only `@rangojs/router:version` virtual and `@vitejs/plugin-rsc/rsc`
 *   (whose real body imports unresolvable Vite virtuals) are stubbed.
 * - Cloudflare apps additionally import the `cloudflare:workers` /
 *   `cloudflare:email` runtime virtuals; pass `{ preset: "cloudflare" }` to stub them.
 *
 * Usage (recommended one-call form — see {@link rangoTestConfig}):
 *
 * ```ts
 * // vitest.config.ts
 * import { defineConfig } from "vitest/config";
 * import { rangoTestConfig } from "@rangojs/router/testing/vitest";
 *
 * export default defineConfig({
 *   test: {
 *     globals: true,
 *     include: ["test/**\/*.test.{ts,tsx}"],
 *     environment: "node",
 *     ...rangoTestConfig({ preset: "cloudflare" }),
 *   },
 * });
 * ```
 *
 * `rangoTestConfig` bundles the resolve aliases ({@link rangoTestAliases}) with
 * the `server.deps.inline` contract ({@link rangoInlineDeps}) an installed
 * consumer needs — @rangojs/router ships as TS source, and without `deps.inline`
 * Vitest hands those `.ts` files to Node, which on Node >= 23 throws
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Use the lower-level
 * `rangoTestAliases` directly only if you wire `deps.inline` yourself.
 *
 * Notes:
 * - This is for the node/DOM project. The Flight project (real RSC rendering via
 *   `@rangojs/router/testing/flight`) uses the `react-server` condition and pure
 *   leaf server components — it does NOT use this alias (which would crash under
 *   the server React build). See the testing guide for the Flight config.
 * - `renderRoute` (`@rangojs/router/testing/dom`) tests run in this same project
 *   under a DOM environment (`happy-dom`/`jsdom`); the alias does not affect them.
 * - LIMITATION: the FULL app router still cannot be imported if it uses
 *   `Prerender()` / `createLoader()` (their build-time-injected `$$id` is absent
 *   in a bare test). Build a router from an importable, Prerender-free include for
 *   `dispatch`, or assert whole-router behavior with e2e.
 */

import { fileURLToPath } from "node:url";

/** A single Vite/Vitest resolve alias entry. Structurally a Vite `Alias`. */
export interface TestAlias {
  find: string | RegExp;
  replacement: string;
}

/** Options for {@link rangoTestAliases}. */
export interface RangoTestAliasOptions {
  /**
   * Deployment preset, matching `rango({ preset })` in the Vite plugin. With
   * `"cloudflare"` the helper additionally stubs the Cloudflare Workers runtime
   * virtuals (`cloudflare:workers` / `cloudflare:email`) a CF app's route tree
   * imports. A string (not a boolean) so more presets can be added without an
   * API change. Default: `"node"`.
   */
  preset?: "node" | "cloudflare";
}

/**
 * Resolve a path relative to this module. Anchored at the PACKAGE ROOT
 * (`../../` from both `src/testing/vitest.ts` and the shipped
 * `dist/testing/vitest.js` — each is two levels below the root), so the alias
 * targets always point at the `src/*.ts` files Vite transpiles at test time,
 * regardless of whether this helper is loaded as source (in-repo) or as the
 * compiled `dist` entry (an installed consumer).
 */
function here(relativeFromRoot: string): string {
  return fileURLToPath(new URL(`../../${relativeFromRoot}`, import.meta.url));
}

/**
 * Build the `resolve.alias` entries a consumer's node/DOM Vitest project needs to
 * import a real @rangojs/router app's router/loaders/middleware. Spread into a
 * Vitest config: `resolve: { alias: rangoTestAliases(...) }` (concat your own
 * aliases as needed).
 */
export function rangoTestAliases(
  opts: RangoTestAliasOptions = {},
): TestAlias[] {
  const aliases: TestAlias[] = [
    // Real impls (index.rsc.ts) for the bare specifier ONLY — exact regex so
    // subpaths (/testing, /client, /cache, ...) are untouched. React stays the
    // client build, so createContext and "use client" modules work.
    { find: /^@rangojs\/router$/, replacement: here("src/index.rsc.ts") },
    {
      find: "@rangojs/router:version",
      replacement: here("src/testing/vitest-stubs/version.ts"),
    },
    {
      find: /^@vitejs\/plugin-rsc\/rsc$/,
      replacement: here("src/testing/vitest-stubs/plugin-rsc.ts"),
    },
  ];

  if (opts.preset === "cloudflare") {
    aliases.push(
      {
        find: "cloudflare:workers",
        replacement: here("src/testing/vitest-stubs/cloudflare-workers.ts"),
      },
      {
        find: "cloudflare:email",
        replacement: here("src/testing/vitest-stubs/cloudflare-email.ts"),
      },
    );
  }

  return aliases;
}

/**
 * Vitest `server.deps.inline` patterns that force Vite (not Node) to transpile
 * @rangojs/router's TypeScript source under test.
 *
 * REQUIRED for an installed (node_modules) consumer: @rangojs/router ships as TS
 * source, and Vitest externalizes node_modules by default — so without this Node
 * loads the `.ts` files directly and, on Node >= 23, throws
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. In this monorepo it is a no-op
 * (the workspace symlink resolves to a realpath outside node_modules, which Vite
 * already transpiles), which is precisely why an in-repo dogfood never surfaces
 * the need and the contract has to be shipped explicitly.
 */
export const rangoInlineDeps: RegExp[] = [/@rangojs[/\\]router/];

/** The Vitest `test`-block fragment {@link rangoTestConfig} returns. */
export interface RangoTestConfig {
  alias: TestAlias[];
  server: { deps: { inline: RegExp[] } };
}

/**
 * The complete Vitest `test`-block fragment a consumer needs: the resolve
 * aliases ({@link rangoTestAliases}) AND the `server.deps.inline` contract
 * ({@link rangoInlineDeps}). Spread it into your `test` block so both land in
 * one place and a consumer cannot forget the `deps.inline` half (omitting it
 * loads rango's TS source through Node and breaks on Node >= 23):
 *
 * ```ts
 * // vitest.config.ts
 * import { defineConfig } from "vitest/config";
 * import { rangoTestConfig } from "@rangojs/router/testing/vitest";
 *
 * export default defineConfig({
 *   test: {
 *     globals: true,
 *     include: ["test/**\/*.test.{ts,tsx}"],
 *     environment: "node",
 *     ...rangoTestConfig({ preset: "cloudflare" }),
 *   },
 * });
 * ```
 */
export function rangoTestConfig(
  opts: RangoTestAliasOptions = {},
): RangoTestConfig {
  return {
    alias: rangoTestAliases(opts),
    // fresh copy so the shared rangoInlineDeps const is never aliased into (or
    // mutated through) a consumer's resolved config
    server: { deps: { inline: [...rangoInlineDeps] } },
  };
}
