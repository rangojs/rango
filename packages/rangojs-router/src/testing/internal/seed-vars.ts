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

export function resolveSeededStateCookieName(seed?: StateCookieSeed): string {
  return resolveStateCookieName(seed?.prefix, seed?.routerId ?? "router_0");
}

export type VarsInit =
  | Record<string, unknown>
  | ReadonlyArray<readonly [ContextVar<unknown> | string, unknown]>;

export function seedVariables(
  variables: Record<string, unknown>,
  vars?: VarsInit,
): Record<string, unknown> {
  if (!vars) return variables;
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
