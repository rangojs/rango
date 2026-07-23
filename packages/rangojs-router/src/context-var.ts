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
 * // Non-cacheable var — ctx.get(User) throws inside a cache() boundary
 * export const User = createVar<UserData>({ cache: false });
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
  /** When false, ctx.get(var) throws inside a cache() boundary. */
  readonly cache: boolean;
  /** Phantom field to carry the type parameter. Never set at runtime. */
  readonly __type?: T;
}

export interface ContextVarOptions {
  /**
   * When false, marks this variable as non-cacheable.
   * Reading this var with ctx.get() inside a cache() boundary throws. Use for
   * inherently request-specific data (user sessions, auth tokens, etc.) that
   * must never be baked into cached segments.
   *
   * @default true
   */
  cache?: boolean;
}

/**
 * Create a typed context variable token.
 *
 * The returned object is used with ctx.set(token, value) and ctx.get(token)
 * for compile-time-checked data flow between handlers, layouts, and middleware.
 */
export function createVar<T>(options?: ContextVarOptions): ContextVar<T> {
  return {
    __brand: "context-var" as const,
    key: Symbol(),
    cache: options?.cache !== false,
  };
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

/**
 * Does a variables object hold any entries? Counts both string keys and the
 * symbol-keyed entries (context vars are stored under symbols), so an object
 * carrying only symbol-keyed vars is still reported as non-empty.
 */
export function hasContextVars(variables: object): boolean {
  return (
    Object.keys(variables).length > 0 ||
    Object.getOwnPropertySymbols(variables).length > 0
  );
}

/**
 * Symbol used as a Set stored on the variables object to track
 * which keys hold non-cacheable values (from write-level { cache: false }).
 */
const NON_CACHEABLE_KEYS: unique symbol = Symbol.for(
  "rango:non-cacheable-keys",
);

function getNonCacheableKeys(variables: any): Set<string | symbol> {
  if (!variables[NON_CACHEABLE_KEYS]) {
    variables[NON_CACHEABLE_KEYS] = new Set();
  }
  return variables[NON_CACHEABLE_KEYS];
}

/**
 * Check if a variable value is non-cacheable (either var-level or write-level).
 */
export function isNonCacheable(
  variables: any,
  keyOrVar: string | ContextVar<any>,
): boolean {
  if (typeof keyOrVar !== "string" && !keyOrVar.cache) {
    return true; // var-level policy
  }
  const key = typeof keyOrVar === "string" ? keyOrVar : keyOrVar.key;
  const set = variables[NON_CACHEABLE_KEYS] as Set<string | symbol> | undefined;
  return set?.has(key) ?? false; // write-level policy
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

export interface ContextSetOptions {
  /**
   * When false, marks this specific write as non-cacheable.
   * "Least cacheable wins" — if either the var definition or this option
   * says cache: false, the value is non-cacheable.
   *
   * @default true (inherits from createVar)
   */
  cache?: boolean;
}

/**
 * Write a variable to the variables store.
 * Accepts either a string key (legacy) or a ContextVar token (typed).
 */
export function contextSet(
  variables: any,
  keyOrVar: string | ContextVar<any>,
  value: any,
  options?: ContextSetOptions,
): void {
  if (typeof keyOrVar === "string") {
    if (FORBIDDEN_KEYS.has(keyOrVar)) {
      throw new Error(
        `ctx.set(): "${keyOrVar}" is a reserved key and cannot be used as a variable name.`,
      );
    }
    variables[keyOrVar] = value;
    if (options?.cache === false) {
      getNonCacheableKeys(variables).add(keyOrVar);
    }
  } else {
    variables[keyOrVar.key] = value;
    // Track write-level non-cacheable (var-level is checked via keyOrVar.cache)
    if (options?.cache === false) {
      getNonCacheableKeys(variables).add(keyOrVar.key);
    }
  }
}
