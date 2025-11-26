/**
 * Shallow comparison utility for selector optimization
 *
 * Used by useNavigation hook to prevent unnecessary re-renders
 * when the selected value hasn't changed.
 *
 * @param a - First value
 * @param b - Second value
 * @returns true if values are shallowly equal
 */
export function shallow<T>(a: T, b: T): boolean {
  // Same reference or primitive equality
  if (Object.is(a, b)) return true;

  // Different types or non-objects
  if (typeof a !== "object" || typeof b !== "object") return false;

  // Null checks
  if (a === null || b === null) return false;

  // Compare object keys
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length !== keysB.length) return false;

  // Check each key's value with Object.is
  for (const key of keysA) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }

  return true;
}
