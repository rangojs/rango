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
 *   `cloudflare:email` runtime virtuals; pass `{ cloudflare: true }` to stub them.
 *
 * Usage:
 *
 * ```ts
 * // vitest.config.ts
 * import { defineConfig } from "vitest/config";
 * import { rangoTestAliases } from "@rangojs/router/testing/vitest";
 *
 * export default defineConfig({
 *   test: { globals: true, include: ["test/**\/*.test.{ts,tsx}"], environment: "node" },
 *   resolve: { alias: rangoTestAliases({ cloudflare: true }) },
 * });
 * ```
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
   * Stub the Cloudflare Workers runtime virtuals (`cloudflare:workers` /
   * `cloudflare:email`). Enable for a Cloudflare app whose route tree imports
   * them. Default: false.
   */
  cloudflare?: boolean;
}

/** Resolve a path relative to this module (works in source + built layouts). */
function here(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
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
    { find: /^@rangojs\/router$/, replacement: here("../index.rsc.ts") },
    {
      find: "@rangojs/router:version",
      replacement: here("./vitest-stubs/version.ts"),
    },
    {
      find: /^@vitejs\/plugin-rsc\/rsc$/,
      replacement: here("./vitest-stubs/plugin-rsc.ts"),
    },
  ];

  if (opts.cloudflare) {
    aliases.push(
      {
        find: "cloudflare:workers",
        replacement: here("./vitest-stubs/cloudflare-workers.ts"),
      },
      {
        find: "cloudflare:email",
        replacement: here("./vitest-stubs/cloudflare-email.ts"),
      },
    );
  }

  return aliases;
}
