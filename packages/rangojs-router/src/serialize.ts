/**
 * Wire-type serialization transforms.
 *
 * The type a handler or loader returns on the server is frequently NOT the type
 * a client receives after serialization. These transforms model that boundary so
 * consumer-facing types (e.g. `Rango.PathResponse`) describe the wire value, not
 * the source value.
 *
 * Two serializers, two transforms — they are intentionally NOT interchangeable:
 *
 * - `JsonSerialize<T>` models plain `JSON.stringify` (`path.json()` /
 *   `fetch().then(r => r.json())`). Lossy: `Date -> string`, `undefined` /
 *   functions / symbols dropped, `Map`/`Set` -> `{}`. `bigint` *throws* (no wire
 *   value), so it collapses the whole result to `never`. Honors `toJSON()`.
 * - `FlightSerialize<T>` models React RSC Flight (loaders, RSC props, cache).
 *   High fidelity: `Date`/`Map`/`Set`/`bigint`/typed arrays/`Promise` are
 *   preserved; ordinary functions and non-global symbols do not cross.
 *
 * ## Overriding (full-transform replacement)
 *
 * Because `Rango.JsonSerialize` / `Rango.FlightSerialize` are type *aliases*, TS
 * cannot let you redefine them directly (aliases don't merge). Instead each alias
 * consults a generic override slot — augment it with a single member that is your
 * complete transform. Delegate to the built-in for the cases you don't change:
 *
 * ```ts
 * declare global {
 *   namespace Rango {
 *     interface FlightSerializeOverride<T> {
 *       app: T extends Money ? number : Rango.FlightSerializeBuiltin<T>;
 *     }
 *   }
 * }
 * // now Rango.FlightSerialize<Money> is number; everything else is the built-in.
 * ```
 *
 * Provide exactly one member: the slot is read as `Override<T>[keyof Override<T>]`,
 * so multiple members union (and conflict). The built-in recurses through the
 * override-aware alias, so an override applies at every nesting level.
 */

import type { ReactNode } from "react";

type JsonPrimitive = string | number | boolean | null;

type AnyFunction = (...args: never[]) => unknown;

// --- JSON ---------------------------------------------------------------------

/**
 * Internal marker for a value that makes `JSON.stringify` throw (`bigint`, or a
 * `toJSON()` returning one). Distinct from `never`, which means "omitted":
 * `undefined`/function/symbol-valued keys are dropped, and such array slots
 * become `null`. A throwing value has no valid JSON wire form, so it propagates
 * up through every container and is excluded at the public boundary (`bigint`
 * alone -> `never`; `{ id: bigint }` -> `never`).
 */
declare const JSON_THROWS: unique symbol;
type JsonThrows = typeof JSON_THROWS;

/** True if union `U` contains the throw marker. */
type HasThrow<U> = [Extract<U, JsonThrows>] extends [never] ? false : true;

/** Map a JSON array/tuple: propagate a throw; else omitted elements become null. */
type JsonSerializeArray<T extends readonly unknown[]> =
  HasThrow<{ [K in keyof T]: JsonRawResolve<T[K]> }[number]> extends true
    ? JsonThrows
    : {
        [K in keyof T]: [JsonRawResolve<T[K]>] extends [never]
          ? null
          : JsonRawResolve<T[K]>;
      };

/** Map a JSON object: propagate a throw; else drop omitted keys. */
type JsonSerializeObject<T> =
  HasThrow<{ [K in keyof T]: JsonRawResolve<T[K]> }[keyof T]> extends true
    ? JsonThrows
    : {
        [K in keyof T as [JsonRawResolve<T[K]>] extends [never]
          ? never
          : K]: JsonRawResolve<T[K]>;
      };

/**
 * Built-in JSON rules, *raw* (may yield the throw marker). Honors `toJSON()` (so
 * `Date -> string` and any class with `toJSON()` serialize correctly), preserves
 * JSON primitives and literals, omits functions / symbols / `undefined`,
 * collapses `Map`/`Set` to `{}`, and marks `bigint` as throwing. Recurses through
 * the override-aware resolver, so registered overrides apply at every level.
 */
type JsonSerializeBuiltinRaw<T> = T extends {
  toJSON(...args: never[]): infer R;
}
  ? JsonRawResolve<R>
  : T extends JsonPrimitive
    ? T
    : T extends bigint
      ? JsonThrows
      : T extends AnyFunction
        ? never
        : T extends symbol
          ? never
          : T extends undefined
            ? never
            : T extends readonly unknown[]
              ? JsonSerializeArray<T>
              : T extends ReadonlyMap<unknown, unknown>
                ? {}
                : T extends ReadonlySet<unknown>
                  ? {}
                  : T extends object
                    ? JsonSerializeObject<T>
                    : never;

/** Override-aware raw JSON resolution (the recursion entry). */
type JsonRawResolve<T> = [keyof Rango.JsonSerializeOverride<T>] extends [never]
  ? JsonSerializeBuiltinRaw<T>
  : Rango.JsonSerializeOverride<T>[keyof Rango.JsonSerializeOverride<T>];

/**
 * Model the result of round-tripping a value through `JSON.stringify` /
 * `JSON.parse`. A registered `Rango.JsonSerializeOverride` replaces the transform
 * wholesale; otherwise the built-in rules apply. Throwing values collapse to
 * `never`.
 */
export type JsonSerialize<T> = Exclude<JsonRawResolve<T>, JsonThrows>;

// --- Flight -------------------------------------------------------------------

/**
 * Built-in Flight rules. Mirrors React's `ReactClientValue` contract: primitives
 * including `bigint`, `undefined`, `null`, symbols, `Date`, `ArrayBuffer` and
 * typed-array views, `Map`, `Set`, `FormData`, `Blob`, `Promise`,
 * `ReadableStream`, and (async) iterables are preserved; ordinary functions
 * resolve to `never`. JSX (`ReactNode`, and the async-node union
 * `ReactNode | Promise<ReactNode>`) is preserved as-is via a non-distributive
 * leaf, so handle/loader returns that carry JSX round-trip unchanged. Recurses
 * through the override-aware `FlightSerialize`.
 *
 * The source of truth is React's own contract, which is intentionally NOT
 * semver-stable across RSC framework APIs — this tracks the React version Rango
 * pins. See:
 * https://react.dev/reference/rsc/use-client#serializable-types-returned-by-server-components
 *
 * Type-level limitations (not detectable structurally, so not modeled): class
 * instances and null-prototype objects are rejected by React at runtime but pass
 * here as their structural shape; non-global symbols are rejected at runtime but
 * `symbol` is preserved here; Server Functions would need an override to be
 * distinguished from ordinary functions (which resolve to `never`).
 */
type FlightSerializeBuiltinRaw<T> = [T] extends [ReactNode | Promise<ReactNode>]
  ? T
  : T extends string | number | boolean | bigint | symbol | null | undefined
    ? T
    : T extends AnyFunction
      ? never
      : T extends Date
        ? Date
        : T extends ArrayBuffer
          ? ArrayBuffer
          : T extends ArrayBufferView
            ? T
            : T extends FormData
              ? FormData
              : T extends Blob
                ? Blob
                : T extends Map<infer K, infer V>
                  ? Map<FlightSerialize<K>, FlightSerialize<V>>
                  : T extends Set<infer V>
                    ? Set<FlightSerialize<V>>
                    : T extends Promise<infer V>
                      ? Promise<FlightSerialize<V>>
                      : T extends ReadableStream<infer V>
                        ? ReadableStream<FlightSerialize<V>>
                        : T extends readonly unknown[]
                          ? { [K in keyof T]: FlightSerialize<T[K]> }
                          : T extends AsyncIterable<infer V>
                            ? AsyncIterable<FlightSerialize<V>>
                            : T extends Iterable<infer V>
                              ? Iterable<FlightSerialize<V>>
                              : T extends object
                                ? { [K in keyof T]: FlightSerialize<T[K]> }
                                : never;

/**
 * Model React RSC Flight serialization. A registered `Rango.FlightSerializeOverride`
 * replaces the transform wholesale; otherwise the built-in rules apply.
 */
export type FlightSerialize<T> = [
  keyof Rango.FlightSerializeOverride<T>,
] extends [never]
  ? FlightSerializeBuiltinRaw<T>
  : Rango.FlightSerializeOverride<T>[keyof Rango.FlightSerializeOverride<T>];

// Module-scoped aliases so the ambient `Rango.*` members below can reference the
// module-level transforms without the global namespace shadowing the names.
type GlobalJsonSerialize<T> = JsonSerialize<T>;
type GlobalJsonSerializeBuiltin<T> = JsonSerializeBuiltinRaw<T>;
type GlobalFlightSerialize<T> = FlightSerialize<T>;
type GlobalFlightSerializeBuiltin<T> = FlightSerializeBuiltinRaw<T>;

/**
 * Ambient serialization transforms and their override slots on the `Rango`
 * namespace. Available with no import wherever the router's types are in scope,
 * alongside `Rango.Path` / `Rango.PathResponse`.
 *
 * `Rango.JsonSerialize` is what `Rango.PathResponse` applies; `Rango.FlightSerialize`
 * is exposed for RSC/loader/cache wire types and must NOT be used for `path.json()`.
 * `Rango.JsonSerializeBuiltin` / `Rango.FlightSerializeBuiltin` are the defaults,
 * exported so an override can delegate to them.
 */
declare global {
  namespace Rango {
    /**
     * Full-transform override slot for `Rango.JsonSerialize`. Empty by default;
     * augment with one member that is your complete transform (delegate to
     * `Rango.JsonSerializeBuiltin<T>` for the cases you don't change).
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface JsonSerializeOverride<T> {}

    /**
     * Full-transform override slot for `Rango.FlightSerialize`. Empty by default;
     * augment with one member that is your complete transform (delegate to
     * `Rango.FlightSerializeBuiltin<T>` for the cases you don't change).
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface FlightSerializeOverride<T> {}

    /** Wire type after `JSON.stringify` (`path.json()` / `fetch().json()`). */
    type JsonSerialize<T> = GlobalJsonSerialize<T>;
    /**
     * Built-in `JsonSerialize` rules, for an override to delegate to. Raw: a
     * `bigint`-bearing type yields the internal throw marker here, which
     * `Rango.JsonSerialize` excludes to `never` at the boundary.
     */
    type JsonSerializeBuiltin<T> = GlobalJsonSerializeBuiltin<T>;
    /** Wire type after RSC Flight serialization (loaders / RSC props / cache). */
    type FlightSerialize<T> = GlobalFlightSerialize<T>;
    /** Built-in `FlightSerialize` rules, for an override to delegate to. */
    type FlightSerializeBuiltin<T> = GlobalFlightSerializeBuiltin<T>;
  }
}
