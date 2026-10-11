/**
 * createActionForm: the FormData a browser posts when a form is submitted
 * before hydration (no JavaScript), for a server action.
 *
 * React's server render writes hidden fields on the form so the POST names its
 * action and carries the bound state; decodeAction / decodeFormState read them
 * back. A test cannot render those fields (react-dom/server does not load under
 * the react-server condition), so this builds the same wire format and
 * registers the action where the plugin-rsc stub's decodeAction resolves it,
 * tagged as a server reference like a built "use server" export so the bound
 * action keeps its `$$id` (onError's actionId, the action phase label).
 * Post the result with `serveShellRequest(router, url, { form })`.
 */

import * as RSDServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
import { registerServerModule } from "./internal/server-modules.js";

/** Options for {@link createActionForm}. */
export interface CreateActionFormOptions {
  /**
   * The action's reference id, `<module id>#<export name>`, as the build gives
   * a "use server" export. Any unique string of that shape in a test.
   */
  id: string;
  /**
   * A `useActionState` form (default): the action runs as `(prevState, formData)`
   * and the POST carries the state key. false: a plain `<form action={fn}>`
   * ($ACTION_ID_), the action runs as `(formData)`.
   */
  useActionState?: boolean;
  /** The form's own fields, as the person filled them. */
  fields?: Record<string, string>;
}

/**
 * Build a no-JS form POST body for `action` and register it so a handler
 * decodes it back to `action`.
 */
export function createActionForm(
  action: (...args: any[]) => unknown,
  options: CreateActionFormOptions,
): FormData {
  const { id, useActionState = true, fields = {} } = options;
  const [moduleId, name] = id.split("#");
  if (!moduleId || !name) {
    throw new Error(
      `createActionForm: id must be "<module id>#<export name>", received ${JSON.stringify(id)}`,
    );
  }
  registerServerModule(moduleId, {
    [name]: RSDServer.registerServerReference(action, moduleId, name),
  });

  const form = new FormData();
  if (useActionState) {
    form.set("$ACTION_REF_1", "");
    form.set("$ACTION_1:0", JSON.stringify({ id, bound: "$@1" }));
    // The state the hook held when the form was submitted: its initial null.
    form.set("$ACTION_1:1", "[null]");
    form.set("$ACTION_KEY", "k0");
  } else {
    form.set(`$ACTION_ID_${id}`, "");
  }
  for (const [field, value] of Object.entries(fields)) form.set(field, value);
  return form;
}
