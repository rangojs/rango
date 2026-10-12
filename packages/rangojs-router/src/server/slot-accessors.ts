/**
 * Property definitions for per-request objects that keep V8 fast properties
 * (#1109): the request context, the middleware ctx, the handle store and a
 * guarded request.
 *
 * V8 puts an object in dictionary mode, where every property read is a hash
 * lookup for the object's whole lifetime, when an object literal declares a
 * get/set member, when a data property is redefined as an accessor after
 * creation, or when an accessor is defined with a function its shape
 * transition has not recorded: a closure created per request is a new
 * function every time. So an accessor on a per-request object is a
 * module-level descriptor, and one that needs per-object state reads a
 * per-object closure from a non-enumerable symbol slot (slotAccessor +
 * defineSlot). A derived object (Object.create(obj)) reads the slot through
 * its prototype; the descriptor copied onto another object reads that
 * object's slot instead. context-fast-properties.test.ts pins all of it.
 *
 * Dependency-free leaf: handle-store.ts is imported by request-context.ts,
 * so these cannot live in either.
 */

type SlotHolder = Record<symbol, () => unknown>;

/**
 * An accessor descriptor whose getter calls the receiver's `slot` closure.
 * Call it once at module level and share the result.
 */
export function slotAccessor(
  slot: symbol,
  enumerable: boolean,
): PropertyDescriptor {
  return {
    get(this: SlotHolder): unknown {
      return this[slot]();
    },
    enumerable,
    configurable: true,
  };
}

/** Define `slot` on `target` as a non-enumerable, read-only data property. */
export function defineSlot(target: object, slot: symbol, value: unknown): void {
  Object.defineProperty(target, slot, { value, configurable: true });
}

/** Define `key` on `target` as a non-enumerable, writable data property. */
export function defineHidden(
  target: object,
  key: PropertyKey,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    configurable: true,
  });
}
