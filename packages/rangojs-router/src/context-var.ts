/**
 * Typed context variables for ctx.set() / ctx.get().
 *
 * createVar<T>() produces a typed token that handlers set and layouts/middleware
 * read. The token carries a unique Symbol used as the property key on the
 * per-request variables object — no build-time processing, no IDs.
 *
 * @example
 * ```ts
 * import { createVar } from "@rangojs/router";
 *
 * interface PaginationData { current: number; total: number }
 * export const Pagination = createVar<PaginationData>();
 *
 * // handler
 * ctx.set(Pagination, { current: 1, total: 4 });
 *
 * // layout
 * const pg = ctx.get(Pagination); // PaginationData | undefined
 * ```
 */

export interface ContextVar<T> {
  readonly __brand: "context-var";
  readonly key: symbol;
  /** Phantom field to carry the type parameter. Never set at runtime. */
  readonly __type?: T;
  /** If true, ctx.get() will not warn when the value was set in a prior pass. */
  readonly stable?: boolean;
}

export interface CreateVarOptions {
  /**
   * Mark this variable as stable across render passes. A stable variable
   * (e.g., a locale or theme token) is expected to keep the same value
   * across action revalidation — ctx.get() will not emit a W2 staleness
   * warning for it even if the producing segment does not revalidate.
   */
  stable?: boolean;
}

/**
 * Create a typed context variable token.
 *
 * The returned object is used with ctx.set(token, value) and ctx.get(token)
 * for compile-time-checked data flow between handlers, layouts, and middleware.
 */
export function createVar<T>(options?: CreateVarOptions): ContextVar<T> {
  return {
    __brand: "context-var" as const,
    key: Symbol(),
    ...(options?.stable ? { stable: true } : undefined),
  };
}

// --- Stable string keys ---
// String keys lack a declaration site, so users opt out of W2 warnings
// by calling markStableVar("key") at module scope.
const stableStringKeys = new Set<string>();

/**
 * Mark a string-keyed context variable as stable across render passes.
 * Stable variables will not trigger W2 staleness warnings during action
 * revalidation, because they are expected to hold constant values
 * (e.g., locale, theme) that do not need refreshing.
 */
export function markStableVar(key: string): void {
  stableStringKeys.add(key);
}

/** Check if a key (string or ContextVar) is marked stable. */
export function isStableVar(keyOrVar: string | ContextVar<any>): boolean {
  if (typeof keyOrVar === "string") return stableStringKeys.has(keyOrVar);
  return keyOrVar.stable === true;
}

/** Reset stable string keys (for tests only). */
export function _resetStableVars(): void {
  stableStringKeys.clear();
}

/**
 * Type guard: is the value a ContextVar token?
 */
export function isContextVar(value: unknown): value is ContextVar<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "__brand" in value &&
    (value as { __brand: unknown }).__brand === "context-var"
  );
}

// --- Pass-scoped freshness tracking (W2 substrate) ---
// A hidden symbol on the variables object holds the set of keys written
// in the current render pass. contextSet records writes; contextGet can
// check freshness. The set is reset at each pass boundary via
// resetPassFreshness().

const FRESH_KEYS: unique symbol = Symbol("context-var-fresh-keys");

/** Get the freshness set from a variables object, creating it if needed. */
function getFreshSet(
  variables: Record<string | symbol, unknown>,
): Set<string | symbol> {
  let set = (variables as any)[FRESH_KEYS] as Set<string | symbol> | undefined;
  if (!set) {
    set = new Set();
    Object.defineProperty(variables, FRESH_KEYS, {
      value: set,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return set;
}

/**
 * Reset the freshness tracking for a new render pass. Call this at each
 * pass boundary (e.g., between action execution and revalidation render).
 * Keys written after this call are "fresh"; pre-existing values that were
 * NOT re-written are "stale" from the perspective of the new pass.
 */
export function resetPassFreshness(
  variables: Record<string | symbol, unknown>,
): void {
  const set = (variables as any)[FRESH_KEYS] as
    | Set<string | symbol>
    | undefined;
  if (set) set.clear();
}

/**
 * Check whether a variable was written in the current pass.
 * Returns true if the key was set since the last resetPassFreshness() call,
 * or if the variables object has no freshness tracking yet (first pass).
 */
export function isFreshInCurrentPass(
  variables: Record<string | symbol, unknown>,
  keyOrVar: string | ContextVar<any>,
): boolean {
  const set = (variables as any)[FRESH_KEYS] as
    | Set<string | symbol>
    | undefined;
  // No freshness set means first pass — everything is fresh.
  if (!set) return true;
  const propKey = typeof keyOrVar === "string" ? keyOrVar : keyOrVar.key;
  return set.has(propKey);
}

/**
 * Read a variable from the variables store.
 * Accepts either a string key (legacy) or a ContextVar token (typed).
 */
export function contextGet(
  variables: any,
  keyOrVar: string | ContextVar<any>,
): any {
  if (typeof keyOrVar === "string") return variables[keyOrVar];
  return variables[keyOrVar.key];
}

/** Keys that must never be used as string variable names */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Write a variable to the variables store.
 * Accepts either a string key (legacy) or a ContextVar token (typed).
 * Records the write in the pass-scoped freshness set.
 */
export function contextSet(
  variables: any,
  keyOrVar: string | ContextVar<any>,
  value: any,
): void {
  if (typeof keyOrVar === "string") {
    if (FORBIDDEN_KEYS.has(keyOrVar)) {
      throw new Error(
        `ctx.set(): "${keyOrVar}" is a reserved key and cannot be used as a variable name.`,
      );
    }
    variables[keyOrVar] = value;
    getFreshSet(variables).add(keyOrVar);
  } else {
    variables[keyOrVar.key] = value;
    getFreshSet(variables).add(keyOrVar.key);
  }
}
