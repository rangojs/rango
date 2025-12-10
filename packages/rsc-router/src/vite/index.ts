import type { Plugin } from "vite";

/**
 * Vite plugin that exposes action IDs on server reference functions.
 *
 * When React Server Components creates server references via createServerReference(),
 * the action ID (format: "hash#actionName") is passed as the first argument but not
 * exposed on the returned function. This plugin transforms the output to attach
 * the $$id property to each server reference function, enabling the router to
 * identify which action was called during revalidation.
 */
export function exposeActionId(): Plugin {
  return {
    name: "rsc-router:expose-action-id",

    renderChunk(code) {
      if (!code.includes("createServerReference(")) {
        return null;
      }

      // Match: createServerReference("hash#actionName", ...)
      const pattern = /createServerReference\(("[a-f0-9]+#[^"]+")([^)]*)\)/g;

      let hasChanges = false;
      const transformed = code.replace(pattern, (_match, idArg, rest) => {
        hasChanges = true;
        return `(function(fn) { fn.$$id = ${idArg}; return fn; })(createServerReference(${idArg}${rest}))`;
      });

      if (hasChanges) {
        return { code: transformed, map: null };
      }
      return null;
    },
  };
}

export interface RscRouterOptions {
  /**
   * Expose $$id property on server action functions.
   * Required for action-based revalidation to work.
   * @default true
   */
  exposeActionId?: boolean;
}

/**
 * Vite plugin for rsc-router.
 *
 * Includes all necessary transforms for the router to function correctly
 * with React Server Components.
 */
export function rscRouter(options: RscRouterOptions = {}): Plugin[] {
  const { exposeActionId: enableExposeActionId = true } = options;

  const plugins: Plugin[] = [];

  if (enableExposeActionId) {
    plugins.push(exposeActionId());
  }

  return plugins;
}
