/**
 * Shared location state utilities - works in both RSC and client contexts
 * No "use client" directive so it can be imported from RSC
 */

/**
 * Internal entry representing a state value with its unique key
 */
export interface LocationStateEntry {
  readonly __rsc_ls_key: string;
  readonly __rsc_ls_value: unknown;
}

/**
 * Options for createLocationState
 */
export interface LocationStateOptions {
  /** When true, the state is cleared from history after first read (flash message pattern) */
  flash?: boolean;
}

/**
 * Type-safe location state definition
 *
 * Created via createLocationState(), used with Link's state prop
 * and useLocationState() hook.
 */
export interface LocationStateDefinition<TArgs extends unknown[], TState> {
  (...args: TArgs): LocationStateEntry;
  /** Injected by Vite plugin - do not set manually */
  __rsc_ls_key: string;
  /** Whether this state auto-clears after first read */
  readonly __rsc_ls_flash: boolean;
  /** Read the current value from history.state (client-side only, undefined during SSR) */
  read(): TState | undefined;
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
 * // Read with hook (reactive)
 * const product = useLocationState(ProductState);
 *
 * // Read without hook (snapshot, client-side only)
 * const snap = ProductState.read();
 * ```
 */
export function createLocationState<TState>(
  options?: LocationStateOptions,
): LocationStateDefinition<[TState | (() => TState)], TState> {
  const flash = options?.flash ?? false;
  let _key: string | undefined;

  function getKey(): string {
    if (!_key && process.env.NODE_ENV !== "production") {
      throw new Error(
        "[rsc-router] createLocationState key not set. " +
          "Make sure the exposeInternalIds Vite plugin is enabled and " +
          "the state is exported with: export const MyState = createLocationState(...)"
      );
    }
    return _key!;
  }

  const fn = (stateOrGetter: TState | (() => TState)): LocationStateEntry => ({
    __rsc_ls_key: getKey(),
    // Resolve getter immediately - lazy evaluation happens via Link's stateRef pattern
    __rsc_ls_value:
      typeof stateOrGetter === "function"
        ? (stateOrGetter as () => TState)()
        : stateOrGetter,
  });

  // Use defineProperty for __rsc_ls_key to avoid Object.assign evaluating
  // the getter during construction (before the Vite plugin sets the key).
  Object.defineProperty(fn, "__rsc_ls_key", {
    get: () => getKey(),
    set: (k: string) => { _key = k; },
    enumerable: true,
    configurable: true,
  });

  Object.defineProperty(fn, "__rsc_ls_flash", {
    value: flash,
    enumerable: true,
  });

  Object.defineProperty(fn, "read", {
    value: (): TState | undefined => {
      if (typeof window === "undefined") return undefined;
      return window.history.state?.[getKey()] as TState | undefined;
    },
    enumerable: true,
  });

  return fn as LocationStateDefinition<[TState | (() => TState)], TState>;
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
    result[entry.__rsc_ls_key] = entry.__rsc_ls_value;
  }
  return result;
}
