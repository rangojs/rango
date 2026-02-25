/**
 * Host Router Utilities
 *
 * Helper functions for type-safe pattern definitions.
 */

/**
 * Define hosts with type safety
 *
 * @example
 * ```ts
 * const hosts = defineHosts({
 *   admin: 'admin.*',
 *   api: 'api.*',
 *   app: ['*', 'www.*']
 * });
 *
 * router.host(hosts.admin).map(...); // Type-safe!
 * ```
 */
export function defineHosts<T extends Record<string, string | string[]>>(
  hosts: T,
): Readonly<T> {
  return Object.freeze(hosts);
}
