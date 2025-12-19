/**
 * Handle API - Typed data passing from server to client
 *
 * Handles allow passing typed data from anywhere on the server (loaders,
 * middleware, handlers, server components) to client components via useHandle.
 */

/**
 * Handle properties (attached to the callable function)
 */
export interface HandleProperties<TData, TAccumulated = TData[]> {
  /** Unique name for this handle (using handleName since function.name is readonly) */
  readonly handleName: string;
  /** Reducer to combine multiple handle calls (default: collect into array) */
  readonly reducer: (acc: TAccumulated, next: TData) => TAccumulated;
  /** Default value when no data has been provided */
  readonly defaultValue: TAccumulated;
  /** Type brand for TData (not used at runtime) */
  readonly _dataType?: TData;
  /** Type brand for TAccumulated (not used at runtime) */
  readonly _accumulatedType?: TAccumulated;
}

/**
 * Handle - a callable function that also carries type/config info
 */
export interface Handle<TData, TAccumulated = TData[]>
  extends HandleProperties<TData, TAccumulated> {
  /** Call to push data to this handle */
  (data: TData | (() => TData | Promise<TData>)): void;
}

/**
 * Default reducer - collects data into an array
 */
function arrayReducer<T>(acc: T[], next: T): T[] {
  return [...acc, next];
}

/**
 * Create a typed handle for passing data from server to client.
 *
 * The returned handle is callable - call it from server code (loaders,
 * middleware, handlers, server components) to push data. Use useHandle()
 * on the client to read the accumulated data.
 *
 * NOTE: This is the client-safe version. On client, calling the handle is a no-op.
 * The server version (via react-server condition) actually pushes data.
 *
 * @param name - Unique identifier for this handle
 * @param reducer - Optional reducer to combine multiple calls (default: collect into array)
 * @param defaultValue - Optional default value (default: [] for array reducer)
 *
 * @example
 * ```typescript
 * // Simple handle - collects into array
 * const breadcrumbs = createHandle<{ label: string; href: string }>('breadcrumbs');
 *
 * // Call from server code
 * breadcrumbs({ label: 'Shop', href: '/shop' });
 * breadcrumbs(async () => ({ label: await getName(), href: '/x' }));
 *
 * // With custom reducer
 * const permissions = createHandle<string[], string[]>(
 *   'permissions',
 *   (acc, next) => [...new Set([...acc, ...next])],
 *   []
 * );
 * ```
 */
export function createHandle<TData, TAccumulated = TData[]>(
  name: string,
  reducer?: (acc: TAccumulated, next: TData) => TAccumulated,
  defaultValue?: TAccumulated
): Handle<TData, TAccumulated> {
  // Use array reducer as default
  const effectiveReducer = reducer ?? (arrayReducer as unknown as (acc: TAccumulated, next: TData) => TAccumulated);
  const effectiveDefault = defaultValue ?? ([] as unknown as TAccumulated);

  // Create the handle properties
  const properties: HandleProperties<TData, TAccumulated> = {
    handleName: name,
    reducer: effectiveReducer,
    defaultValue: effectiveDefault,
  };

  // Client version: no-op callable (handles only work server-side)
  const handle = ((_data: TData | (() => TData | Promise<TData>)) => {
    // No-op on client
  }) as Handle<TData, TAccumulated>;

  // Attach properties to the function
  Object.assign(handle, properties);

  return handle;
}

/**
 * Type helper to extract the data type from a Handle
 */
export type HandleData<H> = H extends Handle<infer T, any> ? T : never;

/**
 * Type helper to extract the accumulated type from a Handle
 */
export type HandleAccumulated<H> = H extends Handle<any, infer A> ? A : never;
