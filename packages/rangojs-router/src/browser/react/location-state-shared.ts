import type { ReactElement } from "react";

/**
 * Internal entry representing a state value with its unique key.
 * When __rsc_ls_lazy is true, __rsc_ls_value holds a getter function
 * that is called at navigation time (not at entry creation time).
 */
export interface LocationStateEntry {
  readonly __rsc_ls_key: string;
  readonly __rsc_ls_value: unknown;
  readonly __rsc_ls_lazy?: boolean;
}

/**
 * Options for createLocationState
 */
export interface LocationStateOptions {
  /** When true, the state is cleared from history after first read (flash message pattern) */
  flash?: boolean;
}

type LocationStateUnsafeFn = (...args: never[]) => unknown;

type LocationStateUnsafeCtor = abstract new (...args: never[]) => unknown;

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> =
  IsAny<T> extends true ? false : unknown extends T ? true : false;

type UnknownReason =
  "`unknown` cannot be verified as serializable; give it a concrete type";
type FunctionReason = "functions cannot be stored in location state";
type ConstructorReason =
  "class constructors cannot be stored in location state";
type SymbolReason = "symbols cannot be stored in location state";
type ReactReason =
  "React/RSC content cannot be stored in location state; store plain data and render it on arrival";
type DepthReason =
  "nested too deep to locate the unsafe field; it is below this path";

/**
 * Branded error surfaced when a value that cannot live in location state is
 * used. Location state is written into `history.state`, which uses the
 * structured clone algorithm; React elements, functions, and symbols throw a
 * `DataCloneError` at runtime. Carries the reason and the offending field's
 * path (`items[].info.values`; `<root>` for the value itself) so the compile
 * error names the field to fix.
 */
export type LocationStateUnsafe<
  Reason extends string,
  Path extends string = "<root>",
> = {
  readonly __rango_location_state_unsafe: Reason;
  readonly __rango_location_state_path: Path;
};

/**
 * Why a value cannot be structured-cloned, for the kinds that fail on their
 * own (not through something nested in them), or `never`. Distributes over a
 * union, one reason per unsafe member.
 */
type UnsafeReason<T> = T extends LocationStateUnsafeFn
  ? FunctionReason
  : T extends LocationStateUnsafeCtor
    ? ConstructorReason
    : T extends symbol
      ? SymbolReason
      : T extends ReactElement
        ? ReactReason
        : never;

/** Primitives and structured-clone built-ins, stored as-is. */
type LocationStatePassthrough =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Date
  | RegExp
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | File
  | FormData;

/**
 * Maps `T` to itself when it is safe to store in location state, or to a branded
 * {@link LocationStateUnsafe} error for the disallowed parts: `unknown`, React
 * elements (RSC/JSX content), functions, class constructors, and symbols.
 * Recurses through arrays, `Map`, `Set`, and plain objects; structured-clone
 * built-ins (`Date`, `RegExp`, typed arrays, `Blob`, `File`, `FormData`) pass
 * through. Consumed by {@link ValidateLocationState}, which is intersected into a
 * definition's value parameter so posting RSC content is a COMPILE error, not a
 * runtime `DataCloneError`. (`any` is unguardable and remains an escape hatch.)
 */
export type LocationStateSafe<T> =
  IsUnknown<T> extends true
    ? LocationStateUnsafe<UnknownReason>
    : T extends unknown
      ? [UnsafeReason<T>] extends [never]
        ? T extends LocationStatePassthrough
          ? T
          : T extends ReadonlyMap<infer K, infer V>
            ? ReadonlyMap<LocationStateSafe<K>, LocationStateSafe<V>>
            : T extends ReadonlySet<infer V>
              ? ReadonlySet<LocationStateSafe<V>>
              : T extends object
                ? { [K in keyof T]: LocationStateSafe<T[K]> }
                : T
        : LocationStateUnsafe<UnsafeReason<T>>
      : never;

type AtPath<P extends string> = P extends "" ? "<root>" : P;

/** `a.b` for a named key; `a[string]` / `a[number]` for an index signature. */
type ChildPath<P extends string, K> = string extends K
  ? `${P}[string]`
  : number extends K
    ? `${P}[number]`
    : K extends string | number
      ? P extends ""
        ? `${K}`
        : `${P}.${K}`
      : `${P}[symbol]`;

type UnsafeAt<R, P extends string> = R extends string
  ? LocationStateUnsafe<R, AtPath<P>>
  : never;

/**
 * Walks `T` to the fields {@link LocationStateSafe} rejects and returns one
 * {@link LocationStateUnsafe} brand per offending path (a union when several
 * fail). Reports the shallowest failures: a value that is itself unsafe stops
 * the walk, and an object with unsafe fields of its own reports only those, so
 * a class instance or DOM node stops at its methods instead of walking its
 * whole object graph (`{ el: HTMLElement }` took 8.4M instantiations and hit
 * TS2589 before). Descends only into children that fail the cached
 * `LocationStateSafe` check, and stops at depth 8.
 */
type LocateUnsafe<
  T,
  P extends string,
  D extends unknown[],
> = D["length"] extends 8
  ? LocationStateUnsafe<DepthReason, AtPath<P>>
  : IsUnknown<T> extends true
    ? LocationStateUnsafe<UnknownReason, AtPath<P>>
    : [UnsafeReason<T>] extends [never]
      ? LocateNested<T, P, D>
      : UnsafeAt<UnsafeReason<T>, P>;

type LocateNested<
  T,
  P extends string,
  D extends unknown[],
> = T extends LocationStatePassthrough
  ? never
  : T extends ReadonlyMap<infer K, infer V>
    ? LocateChild<K, `${P}<key>`, D> | LocateChild<V, `${P}<value>`, D>
    : T extends ReadonlySet<infer V>
      ? LocateChild<V, `${P}[]`, D>
      : T extends readonly unknown[]
        ? number extends T["length"]
          ? LocateChild<T[number], `${P}[]`, D>
          : {
              [K in keyof T & `${number}`]-?: LocateChild<
                T[K],
                `${P}[${K}]`,
                D
              >;
            }[keyof T & `${number}`]
        : T extends object
          ? LocateFields<T, P, D, OwnUnsafeKeys<T>>
          : never;

/**
 * Keys whose value is unsafe itself, not through something nested in it.
 * `any` is never one: it passes LocationStateSafe, so reporting it would
 * leave nothing to report and hide its siblings' paths.
 */
type OwnUnsafeKeys<T> = {
  [K in keyof T]-?: IsAny<T[K]> extends true
    ? never
    : IsUnknown<T[K]> extends true
      ? K
      : [UnsafeReason<T[K]>] extends [never]
        ? never
        : K;
}[keyof T];

type LocateFields<
  T,
  P extends string,
  D extends unknown[],
  Own extends keyof T,
> = [Own] extends [never]
  ? { [K in keyof T]-?: LocateChild<T[K], ChildPath<P, K>, D> }[keyof T]
  : { [K in Own]-?: LocateChild<T[K], ChildPath<P, K>, D> }[Own];

type LocateChild<T, P extends string, D extends unknown[]> = [T] extends [
  LocationStateSafe<T>,
]
  ? never
  : LocateUnsafe<T, P, [...D, unknown]>;

type GenericReason =
  "location state must be serializable: React/RSC content, functions, and symbols cannot be stored — pass plain data and render it on arrival";

/**
 * `unknown` (a no-op) when `T` is safe to store in location state, otherwise a
 * branded {@link LocationStateUnsafe} object naming the reason and the path of
 * each offending field, e.g. `LocationStateUnsafe<"...", "items[].info.values">`.
 * Intersected into the value parameter of a definition's call and `write()` so
 * POSTING RSC content (or any non-serializable value) is a compile error whose
 * text carries the reason and the field — without a `TState extends ...`
 * self-constraint, which TypeScript rejects as circular (TS2313). For safe `T`,
 * `value & unknown` collapses back to `value`, so valid usage is unchanged.
 */
export type ValidateLocationState<T> = [T] extends [LocationStateSafe<T>]
  ? unknown
  : OrGenericUnsafe<LocateUnsafe<T, "", []>>;

type OrGenericUnsafe<U> = [U] extends [never]
  ? LocationStateUnsafe<GenericReason>
  : U;

/**
 * Type-safe location state definition
 *
 * Created via createLocationState(), used with Link's state prop
 * and useLocationState() hook.
 */
export interface LocationStateDefinition<TArgs extends unknown[], TState> {
  (...args: TArgs): LocationStateEntry;
  /**
   * Injected by Vite plugin - do not set manually. Unit tests without the
   * plugin use withLocationStateKey() from @rangojs/router/testing.
   */
  __rsc_ls_key: string;
  /** Whether this state auto-clears after first read */
  readonly __rsc_ls_flash: boolean;
  /**
   * Read the current value from history.state.
   *
   * Returns undefined during SSR (no `window`). To stay hydration-safe, do
   * NOT call read() inline during the initial render — the server returns
   * undefined while the client may have a value preserved in history.state
   * (e.g. after a hard reload of an entry that earlier called write()),
   * which causes a hydration mismatch. Call read() inside an event handler
   * or a useEffect post-mount instead, or use useLocationState() if you
   * want React to manage subscription/hydration for you.
   */
  read(): TState | undefined;
  /**
   * Read this definition's slot from a location snapshot instead of the
   * current entry: a transition({ when }) context's `from` / `to`, or any
   * `{ state }` holding a `history.state` object. A snapshot read never clears
   * flash state.
   */
  read(location: { readonly state: unknown }): TState | undefined;
  /**
   * Statically write the value into the current history entry under this
   * definition's key, preserving any other keys already on history.state
   * (e.g. router bookkeeping, other LocationState slots).
   *
   * This is the non-reactive counterpart to read(): it does not dispatch any
   * event, so components reading via useLocationState() will NOT re-render
   * until the next navigation/popstate. Use it when you only need the value
   * to be there on the next read() or on the next mount (including after
   * back/forward and hard refresh of the same entry).
   *
   * Client-only: throws when called on the server (no history available).
   */
  write(value: TState & ValidateLocationState<TState>): void;
  /**
   * Statically remove this definition's slot from the current history entry,
   * leaving any other keys on history.state untouched. Idempotent: removing
   * a slot that isn't present is a no-op.
   *
   * Same non-reactive semantics as write(): no event is dispatched, so
   * useLocationState() readers will NOT re-render until the next navigation.
   *
   * Client-only: throws when called on the server (no history available).
   */
  delete(): void;
}

/**
 * Create a type-safe location state definition
 *
 * The key is auto-injected by the Vite exposeInternalIds plugin as a property
 * based on file path and export name. No manual key required.
 *
 * @param options Optional configuration
 * @returns A typed state definition for use with Link and useLocationState
 *
 * @example
 * ```typescript
 * // Persistent state (survives back/forward)
 * export const ProductState = createLocationState<{ name: string; price: number }>();
 *
 * // Flash state (cleared after first read)
 * export const FlashMessage = createLocationState<{ text: string }>({ flash: true });
 *
 * // Use in Link
 * <Link to="/product/123" state={[ProductState({ name: "Widget", price: 9.99 })]}>
 *
 * // Just-in-time typed state (getter called at click time, not render time).
 * // Must be in a client component — the getter function can't cross the RSC boundary.
 * <Link
 *   to="/product/123"
 *   state={[ProductState(() => ({ name: product.name, price: product.price }))]}
 * >
 *
 * // Read with hook (reactive)
 * const product = useLocationState(ProductState);
 *
 * // Read without hook (snapshot, client-side only)
 * const snap = ProductState.read();
 *
 * // Static write to current history entry (non-reactive, client-side only).
 * // Survives back/forward and hard refresh; useLocationState() readers will
 * // NOT see the new value until the next navigation. Pair with .read() or a
 * // fresh mount.
 * ProductState.write({ name: "Widget", price: 9.99 });
 *
 * // Manually clear the slot (non-reactive, client-side only).
 * ProductState.delete();
 * ```
 */
let onCurrentStateReplaced: (() => void) | undefined;

/**
 * @internal The navigation store registers here (navigation-store.ts) to
 * refresh its per-entry memory: back/forward reads the entry being left from
 * that memory (at popstate history.state already belongs to the destination),
 * so a write after the entry's commit must reach it.
 */
export function setCurrentHistoryStateListener(
  listener: (() => void) | undefined,
): void {
  onCurrentStateReplaced = listener;
}

/** Replace the current entry's history.state in place (same URL). */
export function replaceCurrentHistoryState(state: unknown): void {
  window.history.replaceState(state, "", window.location.href);
  onCurrentStateReplaced?.();
}

export function createLocationState<TState>(
  options?: LocationStateOptions,
): LocationStateDefinition<
  [(TState | (() => TState)) & ValidateLocationState<TState>],
  TState
> {
  const flash = options?.flash ?? false;
  let _key: string | undefined;

  // Dev and test throw; production folds the check away (the plugin always
  // injects the key there). Without it, reads and writes silently target
  // history.state["undefined"].
  function getKey(): string {
    if (!_key && process.env.NODE_ENV !== "production") {
      throw new Error(
        "[rango] createLocationState key not set. " +
          "Make sure the exposeInternalIds Vite plugin is enabled and " +
          "the state is exported with: export const MyState = createLocationState(...). " +
          "In a unit test without the plugin, assign one with " +
          "withLocationStateKey(MyState) from @rangojs/router/testing.",
      );
    }
    return _key!;
  }

  const fn = (stateOrGetter: TState | (() => TState)): LocationStateEntry => {
    if (typeof stateOrGetter === "function") {
      // Store getter as-is; resolved at navigation time by resolveLocationStateEntries()
      return {
        __rsc_ls_key: getKey(),
        __rsc_ls_value: stateOrGetter,
        __rsc_ls_lazy: true,
      };
    }
    return {
      __rsc_ls_key: getKey(),
      __rsc_ls_value: stateOrGetter,
    };
  };

  // Use defineProperty for __rsc_ls_key to avoid Object.assign evaluating
  // the getter during construction (before the Vite plugin sets the key).
  Object.defineProperty(fn, "__rsc_ls_key", {
    get: () => getKey(),
    set: (k: string) => {
      _key = k;
    },
    enumerable: true,
    configurable: true,
  });

  Object.defineProperty(fn, "__rsc_ls_flash", {
    value: flash,
    enumerable: true,
  });

  Object.defineProperty(fn, "read", {
    value: (location?: { readonly state: unknown }): TState | undefined => {
      if (location !== undefined) {
        const state = location.state;
        return state !== null && typeof state === "object"
          ? ((state as Record<string, unknown>)[getKey()] as TState | undefined)
          : undefined;
      }
      if (typeof window === "undefined") return undefined;
      return window.history.state?.[getKey()] as TState | undefined;
    },
    enumerable: true,
  });

  Object.defineProperty(fn, "write", {
    value: (value: TState): void => {
      if (typeof window === "undefined") {
        throw new Error(
          "[rango] LocationState.write() is client-only. " +
            "It mutates window.history.state and cannot run on the server.",
        );
      }
      const key = getKey();
      // history.state may be a non-null primitive (string/number/boolean) if
      // non-Rango code called pushState/replaceState with one. `?? {}` only
      // catches null/undefined, so spreading a primitive would yield indexed
      // char/no keys and corrupt history.state. Coerce any non-object to a fresh
      // dict — mirrors the delete() guard.
      const existing = window.history.state;
      const current =
        existing !== null && typeof existing === "object" ? existing : {};
      replaceCurrentHistoryState({ ...current, [key]: value });
    },
    enumerable: true,
  });

  Object.defineProperty(fn, "delete", {
    value: (): void => {
      if (typeof window === "undefined") {
        throw new Error(
          "[rango] LocationState.delete() is client-only. " +
            "It mutates window.history.state and cannot run on the server.",
        );
      }
      const key = getKey();
      const current = window.history.state;
      // history.state may be a non-null primitive (string/number/boolean) if
      // non-Rango code called pushState/replaceState with one. `key in
      // <primitive>` throws, so require an object before the `in` check; a
      // primitive carries no slots, so deletion is a no-op.
      if (current === null || typeof current !== "object" || !(key in current))
        return;
      const next = { ...current };
      delete next[key];
      replaceCurrentHistoryState(next);
    },
    enumerable: true,
  });

  return fn as unknown as LocationStateDefinition<
    [(TState | (() => TState)) & ValidateLocationState<TState>],
    TState
  >;
}

/**
 * A definition's key, or undefined when none is set, without the missing-key
 * throw of the `__rsc_ls_key` getter. For dev checks and test helpers.
 */
export function peekLocationStateKey(definition: object): string | undefined {
  try {
    return (definition as { __rsc_ls_key?: string }).__rsc_ls_key || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if a value is a LocationStateDefinition (a createLocationState()
 * result, callable, not an entry).
 */
export function isLocationStateDefinition(
  value: unknown,
): value is LocationStateDefinition<unknown[], unknown> {
  return typeof value === "function" && "__rsc_ls_flash" in value;
}

/**
 * Check if a value is a LocationStateEntry
 */
export function isLocationStateEntry(
  value: unknown,
): value is LocationStateEntry {
  return (
    value !== null &&
    typeof value === "object" &&
    "__rsc_ls_key" in value &&
    "__rsc_ls_value" in value &&
    typeof (value as LocationStateEntry).__rsc_ls_key === "string"
  );
}

/**
 * Resolve state entries into a flat object for history.state
 */
export function resolveLocationStateEntries(
  entries: LocationStateEntry[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    result[entry.__rsc_ls_key] = entry.__rsc_ls_lazy
      ? (entry.__rsc_ls_value as () => unknown)()
      : entry.__rsc_ls_value;
  }
  return result;
}
