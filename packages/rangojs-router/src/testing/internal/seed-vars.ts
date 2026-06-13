/**
 * Variable seeding shared by the node/DOM testing tier (internal/context.ts)
 * AND the react-server Flight tier (flight.ts). Depends only on the
 * dependency-free `context-var` module and the env-agnostic state-cookie-name
 * composition (no window/document), so it is safe to import under the
 * `react-server` condition (unlike internal/context.ts, which pulls
 * client/browser modules).
 */
import { contextSet, type ContextVar } from "../../context-var.js";
import { resolveStateCookieName } from "../../router/state-cookie-name.js";

/**
 * Seed for the rango state cookie a handler/action/loader rotates when it calls
 * `invalidateClientCache()`. Production always resolves a name at router init
 * (so rotation always fires); the test stub did not, so the call silently
 * no-opped. Supplying this (or accepting the defaults) closes that gap. Lives in
 * the react-server-safe seed module so both the node tier (createTestRequestContext)
 * and the Flight tier (renderHandler) share one shape and one default.
 */
export interface StateCookieSeed {
  /**
   * Cookie-name prefix, sanitized then composed with `routerId` exactly like
   * `createRouter({ stateCookiePrefix })`. Defaults to `"rango-state"`.
   */
  prefix?: string;
  /**
   * Router id; the resolved name is `{sanitizedPrefix}_{sanitizedRouterId}`.
   * Defaults to `"router_0"` (the name a single default router resolves to), so
   * the default name is `rango-state_router_0`.
   */
  routerId?: string;
  /**
   * Build version used as the rotated value's prefix (`{version}:{timestamp}`).
   * Defaults to `"0"` (resolved inside createRequestContext).
   */
  version?: string;
}

/**
 * Resolve the state cookie name a seed maps to, mirroring `createRouter`'s
 * `resolveStateCookieName` so a test asserts the SAME name production writes.
 * The default routerId `"router_0"` matches a single default router.
 */
export function resolveSeededStateCookieName(seed?: StateCookieSeed): string {
  return resolveStateCookieName(seed?.prefix, seed?.routerId ?? "router_0");
}

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
