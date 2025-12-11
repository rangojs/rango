/**
 * Utilities for working with server action references on the client
 */

/**
 * Result of $$FORM_ACTION call
 * @internal
 */
interface FormActionResult {
  name: string;
  method: string;
  encType: string;
  data: FormData | null;
}

/**
 * Server action function with React's internal properties
 * @internal
 */
interface ServerActionFunction extends Function {
  $$FORM_ACTION?: (identifierPrefix: string) => FormActionResult;
}

/**
 * Extracts the action ID from a server action function reference.
 *
 * This works by calling React's internal $$FORM_ACTION method which
 * returns form encoding data containing the action ID.
 *
 * @param action - A server action function reference
 * @returns The action ID (e.g., "040b48264065#addToCart") or undefined if not a server action
 *
 * @example
 * ```ts
 * import { addToCart } from './actions';
 * const id = getActionId(addToCart);
 * // id = "040b48264065#addToCart"
 * ```
 */
export function getActionId(action: Function): string | undefined {
  const serverAction = action as ServerActionFunction;
  const formAction = serverAction.$$FORM_ACTION;

  if (typeof formAction !== "function") {
    return undefined;
  }

  try {
    const result = formAction.call(action, "");
    // result.name is "$ACTION_ID_hash#actionName" for unbound actions
    // or "$ACTION_REF_..." for bound actions
    if (result.name.startsWith("$ACTION_ID_")) {
      return result.name.slice("$ACTION_ID_".length);
    }
    if (result.name.startsWith("$ACTION_REF_")) {
      // For bound actions, we need to extract from the FormData
      // The ID is stored in the form data
      return undefined; // TODO: handle bound actions if needed
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Extracts the action name from a server action function reference.
 *
 * @param action - A server action function reference
 * @returns The action name (e.g., "addToCart") or undefined if not a server action
 *
 * @example
 * ```ts
 * import { addToCart } from './actions';
 * const name = getActionName(addToCart);
 * // name = "addToCart"
 * ```
 */
export function getActionName(action: Function): string | undefined {
  const id = getActionId(action);
  if (!id) return undefined;

  const hashIndex = id.indexOf("#");
  if (hashIndex === -1) return undefined;

  return id.slice(hashIndex + 1);
}

/**
 * Checks if a function is a server action reference.
 *
 * @param fn - Any function
 * @returns true if the function is a server action reference
 *
 * @example
 * ```ts
 * import { addToCart } from './actions';
 *
 * isServerAction(addToCart); // true
 * isServerAction(() => {}); // false
 * ```
 */
export function isServerAction(fn: Function): boolean {
  return typeof (fn as ServerActionFunction).$$FORM_ACTION === "function";
}
