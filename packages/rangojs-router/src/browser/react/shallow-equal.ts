/**
 * Shallow equality check for selector results.
 * Uses Object.is for value comparison (handles NaN and +-0 correctly).
 *
 * Only a plain object or an array compares by its own enumerable keys, so a
 * selector that rebuilds an object each call keeps its reference while its
 * content is equal. Every other object compares by identity.
 *
 * Why: a `URL`, `URLSearchParams`, `Date` or `Map` has no own enumerable keys,
 * so a key comparison calls any two of them equal. `useNavigation(n => n.location)`
 * read the first URL for the life of the component. A selector that builds an
 * instance per call (`n => new URL(n.location)`) takes a new value on every
 * notification; that is the caller's own cost, and the alternative is a value
 * that never moves.
 *
 * A selector result may be an array or a plain object whose own keys are class
 * instances (useParams, useHandle's collected values): those inner values were
 * always compared by identity, and still are.
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }
  // A container and a plain object with the same own keys are not the same
  // value: `["a"]` and `{0: "a"}` differ in prototype and in length.
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (!isKeyedContainer(a) || !isKeyedContainer(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (
      !Object.hasOwn(b, key) ||
      !Object.is((a as any)[key], (b as any)[key])
    ) {
      return false;
    }
  }
  return true;
}

/** A value whose own enumerable keys describe it: an array or a plain object. */
function isKeyedContainer(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}
