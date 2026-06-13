/**
 * Shared route-param comparison helpers.
 */

/**
 * Shallow equality for two route-param records. Same-reference is a fast path;
 * otherwise compares key count then each value.
 */
export function paramsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  if (a === b) return true;

  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;

  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }

  return true;
}
