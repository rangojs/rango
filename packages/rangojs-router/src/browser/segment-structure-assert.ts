import type { ResolvedSegment } from "./types.js";

/**
 * Tree structure categories for the `loading` property.
 *
 * The `loading` value on a segment determines the React element tree
 * that renderSegments() produces. Different categories produce different
 * element nesting, which causes React to remount components when the
 * category changes between renders (SSR -> navigation -> action).
 *
 * "none"       -> OutletProvider (no boundary wrapping)
 * "suppressed" -> LoaderBoundary > Suspense > LoaderResolver > OutletProvider
 *                 (boundary present, but no RouteContentWrapper for children)
 * "active"     -> LoaderBoundary > Suspense > LoaderResolver > OutletProvider
 *                 > RouteContentWrapper > Suspense > Suspender > component
 */
type LoadingCategory = "none" | "suppressed" | "active";

function getLoadingCategory(loading: unknown): LoadingCategory {
  if (loading === undefined || loading === null) return "none";
  if (loading === false) return "suppressed";
  return "active";
}

/**
 * Assert that merging a server segment with a cached segment won't change
 * the React tree structure. Logs a warning in development when a mismatch
 * is detected.
 *
 * This catches the class of bugs where `loading()` with `{ ssr: false }`
 * produces `loading=false` on SSR but `loading=<skeleton>` on actions,
 * causing React to remount LoaderBoundary/RouteContentWrapper and destroy
 * client state (useActionState, refs, etc.).
 *
 * @param cached - The currently cached segment
 * @param incoming - The new segment from server
 * @param context - Where this merge is happening (for the warning message)
 */
export function assertSegmentStructure(
  cached: ResolvedSegment,
  incoming: ResolvedSegment,
  context: string,
): void {
  if (process.env.NODE_ENV === "production") return;

  const cachedCategory = getLoadingCategory(cached.loading);
  const incomingCategory = getLoadingCategory(incoming.loading);

  if (cachedCategory !== incomingCategory) {
    console.warn(
      `[RSC Router] Tree structure mismatch detected in ${context} ` +
        `for segment "${cached.id}": loading category changed from ` +
        `"${cachedCategory}" (${describeLoading(cached.loading)}) to ` +
        `"${incomingCategory}" (${describeLoading(incoming.loading)}). ` +
        `This will cause React to remount the component, destroying ` +
        `useActionState and other client state. ` +
        `The merge code should preserve the cached loading value.`,
    );
  }
}

function describeLoading(loading: unknown): string {
  if (loading === undefined) return "undefined";
  if (loading === null) return "null";
  if (loading === false) return "false";
  return "ReactNode";
}
