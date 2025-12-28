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
 * Type-safe location state definition
 *
 * Created via createLocationState(), used with Link's state prop
 * and useLocationState() hook.
 */
export interface LocationStateDefinition<TArgs extends unknown[], TState> {
  (...args: TArgs): LocationStateEntry;
  readonly __rsc_ls_key: string;
}

// Track used keys to detect duplicates in development
const usedKeys = new Set<string>();

/**
 * Create a type-safe location state definition
 *
 * The key must be a stable string identifier that persists across
 * module reloads and page refreshes. This ensures state can be
 * correctly read from history.state.
 *
 * @param key Stable unique identifier for this state (e.g., "product", "cart")
 * @returns A typed state definition for use with Link and useLocationState
 *
 * @example
 * ```typescript
 * // Define typed state with stable key
 * const ProductState = createLocationState<{ name: string; price: number }>("product");
 *
 * // Use in Link - state is captured at click time
 * <Link to="/product/123" state={[ProductState({ name: product.name, price: product.price })]}>
 *   View Product
 * </Link>
 *
 * // Multiple states
 * <Link to="/checkout" state={[ProductState(productData), CartState(cartData)]}>
 *   Checkout
 * </Link>
 *
 * // For lazy evaluation (click-time), pass a getter
 * <Link to="/product" state={[ProductState(() => ({ name: product.name }))]}>
 *
 * // Read with type safety
 * const productState = useLocationState(ProductState);
 * // productState: { name: string; price: number } | undefined
 * ```
 */
export function createLocationState<TState>(
  key: string
): LocationStateDefinition<[TState | (() => TState)], TState> {
  const fullKey = `__rsc_ls_${key}`;

  // Warn about duplicate keys in development
  if (process.env.NODE_ENV !== "production" && usedKeys.has(fullKey)) {
    console.warn(
      `[rsc-router] Duplicate location state key "${key}". ` +
        `Each createLocationState call should have a unique key.`
    );
  }
  usedKeys.add(fullKey);

  const definition = Object.assign(
    (stateOrGetter: TState | (() => TState)): LocationStateEntry => ({
      __rsc_ls_key: fullKey,
      // Resolve getter immediately - lazy evaluation happens via Link's stateRef pattern
      __rsc_ls_value:
        typeof stateOrGetter === "function"
          ? (stateOrGetter as () => TState)()
          : stateOrGetter,
    }),
    { __rsc_ls_key: fullKey }
  );

  return definition as LocationStateDefinition<[TState | (() => TState)], TState>;
}

/**
 * Check if a value is a LocationStateEntry
 */
export function isLocationStateEntry(value: unknown): value is LocationStateEntry {
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
  entries: LocationStateEntry[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    result[entry.__rsc_ls_key] = entry.__rsc_ls_value;
  }
  return result;
}
