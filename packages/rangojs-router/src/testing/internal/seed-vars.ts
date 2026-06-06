/**
 * Variable seeding shared by the node/DOM testing tier (internal/context.ts)
 * AND the react-server Flight tier (flight.ts). Depends only on the
 * dependency-free `context-var` module, so it is safe to import under the
 * `react-server` condition (unlike internal/context.ts, which pulls
 * client/browser modules).
 */
import { contextSet, type ContextVar } from "../../context-var.js";

/**
 * Initializer for seeded context variables (as a prior middleware would have
 * set, or a server component would read during render). Either a plain object
 * keyed by var name (the common, best-inferring form: `{ user: u }`) or a list
 * of `[key, value]` tuples where the key may be a `createVar()` handle or a
 * string (`[[userVar, u], ["flag", true]]`).
 */
export type VarsInit =
  | Record<string, unknown>
  | ReadonlyArray<readonly [ContextVar<unknown> | string, unknown]>;

/**
 * Preload variables as if set by upstream middleware (or visible to a rendered
 * server tree). Accepts entries keyed by either a ContextVar (from createVar) or
 * a string, matching ctx.set().
 */
export function seedVariables(
  variables: Record<string, unknown>,
  vars?: VarsInit,
): Record<string, unknown> {
  if (!vars) return variables;
  // Array/iterable form -> use the tuples as-is; plain object -> its entries.
  const entries: Iterable<readonly [ContextVar<unknown> | string, unknown]> =
    Symbol.iterator in (vars as object)
      ? (vars as ReadonlyArray<
          readonly [ContextVar<unknown> | string, unknown]
        >)
      : Object.entries(vars as Record<string, unknown>);
  for (const [key, value] of entries) {
    contextSet(variables, key as ContextVar<unknown>, value);
  }
  return variables;
}
