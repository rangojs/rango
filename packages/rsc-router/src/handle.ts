/**
 * Handle definition for accumulating data across route segments.
 *
 * Handles allow server-side route handlers to pass accumulated data to client
 * components. Unlike loaders (which fetch data for specific routes), handles
 * accumulate data across all matched route segments.
 *
 * @example
 * ```ts
 * // Define a handle
 * const Breadcrumbs = createHandle<BreadcrumbItem>("breadcrumbs");
 *
 * // Use in handler
 * const push = ctx.use(Breadcrumbs);
 * push({ label: "Home", href: "/" });
 *
 * // Consume on client
 * const crumbs = useHandle(Breadcrumbs);
 * ```
 */
export interface Handle<TData, TAccumulated = TData[]> {
  /**
   * Brand to distinguish handles from loaders in ctx.use()
   */
  readonly __brand: "handle";

  /**
   * Unique name for this handle (used as key in storage)
   */
  readonly name: string;

  /**
   * Reducer function to accumulate data.
   * Default: collect into array
   */
  readonly reducer: (acc: TAccumulated, next: TData) => TAccumulated;

  /**
   * Default value when no data has been pushed.
   */
  readonly defaultValue: TAccumulated;
}

/**
 * Default reducer that collects items into an array.
 */
function arrayReducer<T>(acc: T[], next: T): T[] {
  return [...acc, next];
}

/**
 * Create a handle definition for accumulating data across route segments.
 *
 * @param name - Unique name for this handle (used as storage key)
 * @param reducer - Optional reducer function (default: collect into array)
 * @param defaultValue - Optional default value (default: empty array)
 *
 * @example
 * ```ts
 * // Default: collect into array
 * const Breadcrumbs = createHandle<BreadcrumbItem>("breadcrumbs");
 * // Result type: BreadcrumbItem[]
 *
 * // Custom: last value wins
 * const PageTitle = createHandle<string, string>(
 *   "pageTitle",
 *   (acc, next) => next,
 *   "Default Title"
 * );
 * // Result type: string
 *
 * // Custom: object merge
 * const Meta = createHandle<Partial<MetaTags>, MetaTags>(
 *   "meta",
 *   (acc, next) => ({ ...acc, ...next }),
 *   { robots: "index,follow" }
 * );
 * // Result type: MetaTags
 * ```
 */
export function createHandle<TData, TAccumulated = TData[]>(
  name: string,
  reducer?: (acc: TAccumulated, next: TData) => TAccumulated,
  defaultValue?: TAccumulated
): Handle<TData, TAccumulated> {
  return {
    __brand: "handle" as const,
    name,
    reducer: reducer ?? (arrayReducer as unknown as (acc: TAccumulated, next: TData) => TAccumulated),
    defaultValue: defaultValue ?? ([] as unknown as TAccumulated),
  };
}

/**
 * Type guard to check if a value is a Handle.
 */
export function isHandle(value: unknown): value is Handle<unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "__brand" in value &&
    (value as { __brand: unknown }).__brand === "handle"
  );
}
