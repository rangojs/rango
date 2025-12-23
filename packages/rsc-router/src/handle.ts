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
   * Collect function to transform segment data into final value.
   * Receives array of arrays - each inner array contains values pushed
   * by one segment, ordered parent-to-child.
   *
   * @param segments - Array of segment data arrays, e.g. [[a, b], [c], [d, e]]
   * @returns The accumulated value
   */
  readonly collect: (segments: TData[][]) => TAccumulated;
}

/**
 * Default collect function that flattens segment arrays into a single array.
 */
function defaultCollect<T>(segments: T[][]): T[] {
  return segments.flat();
}

/**
 * Create a handle definition for accumulating data across route segments.
 *
 * @param name - Unique name for this handle (used as storage key)
 * @param collect - Optional collect function (default: flatten into array)
 *
 * @example
 * ```ts
 * // Default: flatten into array
 * const Breadcrumbs = createHandle<BreadcrumbItem>("breadcrumbs");
 * // Result type: BreadcrumbItem[]
 *
 * // Custom: last value wins
 * const PageTitle = createHandle<string, string>(
 *   "pageTitle",
 *   (segments) => segments.flat().at(-1) ?? "Default Title"
 * );
 * // Result type: string
 *
 * // Custom: object merge
 * const Meta = createHandle<Partial<MetaTags>, MetaTags>(
 *   "meta",
 *   (segments) => Object.assign({ robots: "index,follow" }, ...segments.flat())
 * );
 * // Result type: MetaTags
 *
 * // Custom: dedupe by href
 * const Breadcrumbs = createHandle<BreadcrumbItem>(
 *   "breadcrumbs",
 *   (segments) => {
 *     const all = segments.flat();
 *     return all.filter((item, i) => all.findIndex(x => x.href === item.href) === i);
 *   }
 * );
 * ```
 */
export function createHandle<TData, TAccumulated = TData[]>(
  name: string,
  collect?: (segments: TData[][]) => TAccumulated
): Handle<TData, TAccumulated> {
  return {
    __brand: "handle" as const,
    name,
    collect:
      collect ??
      (defaultCollect as unknown as (segments: TData[][]) => TAccumulated),
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
