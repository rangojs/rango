/**
 * Shared `isAction()` matcher for revalidate predicates (server + clientUrls).
 *
 * Action identity is `actionId`. The helper resolves an imported reference the
 * same way the action boundary derives that id (`$id ?? $$id`), so a
 * rename-safe `isAction(fn)` / `isAction(namespace)` match works in both the
 * RSC environment (file-path `$id`) and the browser (hashed `$$id`).
 */

import type { ActionRef, IsActionFn } from "../types.js";

// Bind preservation is per-reference, in expose-action-id.ts. Do not patch
// Function.prototype.bind here (rsc+ssr share a realm; global wrap stacks).

/**
 * Resolve a server-action reference's stable id, mirroring how the action
 * boundary derives `actionContext.actionId` in `rsc/server-action.ts`
 * (`$id ?? $$id`): the file-path `$id` set by the expose-action-id plugin in a
 * production RSC build when present, otherwise React's `$$id`. Resolving both
 * the incoming `actionId` and the reference with the same precedence makes
 * `isAction()` form-agnostic across dev and production.
 */
export function resolveActionRefId(ref: unknown): string | undefined {
  if (ref == null) return undefined;
  const r = ref as { $id?: unknown; $$id?: unknown };
  if (typeof r.$id === "string") return r.$id;
  if (typeof r.$$id === "string") return r.$$id;
  return undefined;
}

/**
 * Depth cap for the object walk. The supported shapes need at most two
 * object levels — a namespace (values are functions) and a grouped-namespace
 * literal (`{ Cart: CartActions }`, values are namespaces). The cap keeps an
 * accidentally passed arbitrary object (a ctx, a data blob — it type-checks
 * as Record<string, unknown>) from triggering a full deep traversal on every
 * predicate call.
 */
const MAX_ACTION_REF_DEPTH = 3;

function matchesActionRef(
  ref: unknown,
  currentActionId: string,
  seen: Set<object>,
  depth: number,
): boolean {
  if (ref == null) return false;
  if (typeof ref === "function") {
    return resolveActionRefId(ref) === currentActionId;
  }
  if (typeof ref !== "object") return false;
  if (depth >= MAX_ACTION_REF_DEPTH) return false;
  if (seen.has(ref)) return false;
  seen.add(ref);
  // Namespace, object literal, or grouped namespaces
  // (`{ Cart: CartActions, Order: OrderActions }`): walk every value.
  // Object.values invokes getters; a throwing getter must not abort the
  // predicate into the fail-open path, so treat it as "no match here".
  let values: unknown[];
  try {
    values = Object.values(ref);
  } catch {
    return false;
  }
  for (const value of values) {
    if (matchesActionRef(value, currentActionId, seen, depth + 1)) return true;
  }
  return false;
}

/**
 * Build the `isAction()` helper bound to the current action. Called with no
 * arguments it answers "is this request an action at all?" — `true` during
 * action handling (including action-triggered refetches that carry no id
 * yet), `false` on plain navigation. Called with one or more action
 * references it narrows to those: a single imported action, several
 * (variadic), a namespace import (`import * as Mod`), an object literal of
 * actions (`{ addToCart, removeFromCart }`), or a grouped namespace object.
 * Returns `false` when there is no action or nothing matches.
 *
 * `inAction` is the request kind. It defaults to "an id is present" so
 * existing server call sites stay a single argument. The client passes the
 * explicit flag so a refetch terminal with `isAction: true` still answers
 * bare `isAction()` even if `actionId` was not threaded.
 */
export function makeIsAction(
  currentActionId: string | undefined,
  inAction: boolean = currentActionId !== undefined,
): IsActionFn {
  return (...actions: ActionRef[]): boolean => {
    if (!inAction) return false;
    if (actions.length === 0) return true;
    if (!currentActionId) return false;
    const seen = new Set<object>();
    for (const action of actions) {
      if (matchesActionRef(action, currentActionId, seen, 0)) return true;
    }
    return false;
  };
}
