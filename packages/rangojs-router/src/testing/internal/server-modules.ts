/**
 * Server reference modules a test registered, by the module id the action's
 * `$$id` (`<module id>#<export name>`) names. The plugin-rsc stub's module
 * loader reads this when decodeAction resolves a no-JS form POST to its action.
 */
const SERVER_MODULES: Map<string, Record<string, unknown>> = new Map();

/**
 * Register `exports` as the server module `id`, merging into an earlier call.
 * The module object is kept and mutated: the stub's require is memoized per
 * id, so a later export must appear on the object it first returned.
 */
export function registerServerModule(
  id: string,
  exports: Record<string, unknown>,
): void {
  const existing = SERVER_MODULES.get(id);
  if (existing) Object.assign(existing, exports);
  else SERVER_MODULES.set(id, { ...exports });
}

/** The module a decoded server reference resolves to. */
export function loadServerModule(id: string): Record<string, unknown> {
  const found = SERVER_MODULES.get(id);
  if (!found) {
    throw new Error(
      `plugin-rsc stub: server reference module "${id}" is not loadable in a test. ` +
        "Build the form with createActionForm() so its action is registered.",
    );
  }
  return found;
}
