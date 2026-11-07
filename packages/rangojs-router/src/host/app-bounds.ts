/**
 * The app bounds table one host router hands the app it dispatches to
 * (src/app-bounds.ts): which paths of the request's host that app owns.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AppBounds, AppBoundsTable } from "../app-bounds.js";
import type { RouteEntry } from "./types.js";
import { matchDomainPart, patternPath } from "./pattern-matcher.js";

/**
 * The table of `matched` for a request to `hostname`: the entries whose host
 * matches it, in match order, cut at the first that covers every path. The
 * fallback route is not an entry: it serves only a rejected hostOverride
 * cookie, and a path no entry covers is a NoRouteMatchError. Trailing entries
 * of other apps are dropped (an uncovered path is another app's anyway).
 * Undefined when the app owns every path, the common case of one app per
 * host.
 */
export function appBoundsTable(
  routes: readonly RouteEntry[],
  matched: RouteEntry,
  hostname: string,
): AppBoundsTable | undefined {
  const table: [string, boolean][] = [];
  const parts = hostname.split(".");
  outer: for (const route of routes) {
    for (const pattern of route.patterns) {
      if (!matchDomainPart(pattern, hostname, parts)) continue;
      const prefix = patternPath(pattern);
      table.push([prefix, route === matched]);
      if (!prefix) break outer;
    }
  }
  while (table.length > 0 && !table[table.length - 1]![1]) table.pop();
  if (table.length === 1 && table[0]![0] === "") return undefined;
  return table;
}

// The same AsyncLocalStorage server/app-bounds-scope.ts reads, through the
// same global symbol; why the two share no module is written there.
const appBoundsALS: AsyncLocalStorage<AppBounds> = ((globalThis as any)[
  Symbol.for("rangojs-router:app-bounds")
] ??= new AsyncLocalStorage<AppBounds>());

/** Run `fn` with `table` added to the bounds of the host routers around it. */
export function runWithAppBounds<R>(
  table: AppBoundsTable | undefined,
  fn: () => R,
): R {
  if (!table) return fn();
  const outer = appBoundsALS.getStore();
  return appBoundsALS.run(outer ? [...outer, table] : [table], fn);
}
