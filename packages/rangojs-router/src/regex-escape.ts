/**
 * Escape a string for literal use inside a RegExp. Single source of truth for
 * the router runtime (matching) and the vite build (transform/scan); a pure,
 * dependency-free leaf so both environments can share it.
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
