import { resolveActionRefId } from "../../router/is-action.js";

/**
 * The id a testing primitive's `action` option names: a single imported
 * server action (its `$id ?? $$id`, as the action boundary derives it) or a
 * raw actionId string. A function without either id throws, naming the
 * primitive.
 */
export function resolveTestActionId(
  action: ((...args: never[]) => unknown) | string | undefined,
  primitive: string,
): string | undefined {
  if (action === undefined) return undefined;
  if (typeof action === "string") return action;
  const id = resolveActionRefId(action);
  if (id === undefined) {
    throw new Error(
      `${primitive}: \`action\` must be a single imported server action ` +
        "(carrying its build-injected id) or an actionId string. The passed " +
        "function has no $id/$$id — outside a built app, pass the id string " +
        'your predicate should match (e.g. "src/actions/cart.ts#addToCart").',
    );
  }
  return id;
}
