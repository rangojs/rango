/**
 * Every ordinary way a consumer calls a method on an object they were handed
 * (a handler's ctx, most often), so a test can run one probe per shape.
 *
 * A mechanism that reads the method's receiver works for `ctx.use(x)` and
 * silently fails for `const { use } = ctx`, a `use` passed as a prop, or a
 * `{ ...ctx }` copy, with no type error. Probing only the method call is how
 * that kind of fix passed review. Loop over these shapes instead.
 */

/** The name of one call shape. */
export type CallShapeName =
  | "method"
  | "detached"
  | "spread"
  | "spread detached"
  | "after await"
  | "after await detached";

/** One way to call `target[key]`. */
export interface CallShape {
  name: CallShapeName;
  /** Calls the method in this shape; rejects if the shape throws. */
  call(...args: unknown[]): Promise<unknown>;
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * The shapes of calling `target[key]`: as a method, detached
 * (`const { use } = ctx`, or handed on as a callback or prop), through a
 * `{ ...target }` copy (as a method and detached), and after an `await`
 * (as a method and detached).
 */
export function callShapes<T extends object>(
  target: T,
  key: keyof T,
): CallShape[] {
  const method = (on: object): AnyFn => {
    const fn = (on as Record<PropertyKey, unknown>)[key];
    if (typeof fn !== "function") {
      throw new TypeError(`${String(key)} is not a function on this object`);
    }
    return fn as AnyFn;
  };
  return [
    { name: "method", call: async (...a) => method(target).apply(target, a) },
    { name: "detached", call: async (...a) => method(target)(...a) },
    {
      name: "spread",
      call: async (...a) => {
        const copy = { ...target };
        return method(copy).apply(copy, a);
      },
    },
    {
      name: "spread detached",
      call: async (...a) => method({ ...target })(...a),
    },
    {
      name: "after await",
      call: async (...a) => {
        await Promise.resolve();
        return method(target).apply(target, a);
      },
    },
    {
      name: "after await detached",
      call: async (...a) => {
        await Promise.resolve();
        return method(target)(...a);
      },
    },
  ];
}
