import type { Plugin } from "vite";
import { exposeActionId } from "./expose-action-id.ts";

// Re-export plugin
export { exposeActionId } from "./expose-action-id.ts";

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
