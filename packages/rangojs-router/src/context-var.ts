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
}

/**
 * Create a typed context variable token.
 *
 * The returned object is used with ctx.set(token, value) and ctx.get(token)
 * for compile-time-checked data flow between handlers, layouts, and middleware.
 */
export function createVar<T>(): ContextVar<T> {
  return { __brand: "context-var" as const, key: Symbol() };
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
 * Read a variable from the variables store.
 * Accepts either a string key (legacy) or a ContextVar token (typed).
 */
export function contextGet(variables: any, keyOrVar: string | ContextVar<any>): any {
  if (typeof keyOrVar === "string") return variables[keyOrVar];
  return variables[keyOrVar.key];
}

/**
 * Write a variable to the variables store.
 * Accepts either a string key (legacy) or a ContextVar token (typed).
 */
export function contextSet(variables: any, keyOrVar: string | ContextVar<any>, value: any): void {
  if (typeof keyOrVar === "string") {
    variables[keyOrVar] = value;
  } else {
    variables[keyOrVar.key] = value;
  }
}
