import type { UrlPatterns } from "./pattern-types.js";

/**
 * What an async `include()` provider may resolve to: a `urls()` value directly,
 * or a module namespace whose `default` export is a `urls()` value (the shape
 * produced by `() => import("./routes")` when the route module does
 * `export default urls(...)`).
 */
export type IncludeModule<TEnv = any> =
  | UrlPatterns<TEnv>
  | { default: UrlPatterns<TEnv> };

/**
 * An async/lazy include provider: a thunk returning a `urls()` value (or a
 * Promise of one). The thunk is stored unevaluated by `include()` and called
 * once, on the first request that matches the prefix — so the route module and
 * its (code-split) subtree are not evaluated at startup.
 *
 * Forward-compatible: `() => import("./routes")` today (async, separate chunk);
 * `() => m.routes` with native `import defer` later (sync, deferred eval).
 */
export type IncludeProvider<TEnv = any> = () =>
  | IncludeModule<TEnv>
  | Promise<IncludeModule<TEnv>>;

/** True when the include() argument is a provider thunk rather than a value. */
export function isIncludeProvider(value: unknown): value is IncludeProvider {
  // A `urls()` value is a (branded) object; a provider is a function.
  return typeof value === "function";
}

/** A `urls()` value is an object exposing a synchronous `handler()`. */
function isUrlPatterns(value: unknown): value is UrlPatterns {
  return (
    !!value && typeof (value as { handler?: unknown }).handler === "function"
  );
}

/**
 * Normalize an async provider's resolved value to a `UrlPatterns`. Accepts a
 * `urls()` value directly or a module whose `default` export is one.
 */
export function resolveIncludeModule<TEnv = any>(
  mod: IncludeModule<TEnv>,
  id?: string,
): UrlPatterns<TEnv> {
  // Prefer an explicit `default` export (the `export default urls(...)`
  // convention) BEFORE duck-typing the namespace. isUrlPatterns() keys on a
  // `.handler` function, but a routes module can legitimately carry a NAMED
  // `export function handler(...)` alongside its `export default urls(...)`;
  // checking the namespace first would then misidentify the whole module as the
  // urls() value and invoke the user's helper as the DSL handler (the group
  // 404s with a misleading error). A bare `() => urls(...)` provider (no
  // module) has no `default`, so it still resolves via the mod-as-value branch.
  const def = (mod as { default?: unknown })?.default;
  if (isUrlPatterns(def)) return def as UrlPatterns<TEnv>;
  if (isUrlPatterns(mod)) return mod as UrlPatterns<TEnv>;
  // The common failure is a module namespace whose `default` is missing or not a
  // urls() value (e.g. only named exports); `typeof` alone says "object" and
  // hides that, so name the keys present. "provider" (not "async provider") —
  // synchronous providers are supported (see IncludeProvider).
  const got =
    mod && typeof mod === "object"
      ? `a module with keys [${Object.keys(mod).join(", ") || "none"}] but no valid \`default\``
      : typeof mod;
  throw new Error(
    `[@rangojs/router] include() provider${id ? ` for "${id}"` : ""} must ` +
      `resolve to a urls() value — either returned directly or as the module's ` +
      `\`default\` export (e.g. \`export default urls(...)\`). Got ${got}.`,
  );
}
