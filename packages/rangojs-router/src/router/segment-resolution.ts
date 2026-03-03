// Barrel re-export -- see segment-resolution/ for implementations.
export { handleHandlerResult } from "./segment-resolution/helpers.js";
export {
  resolveLoaders,
  type ResolveSegmentOptions,
  resolveSegment,
  resolveOrphanLayout,
  resolveParallelEntry,
  resolveWithErrorHandling,
  resolveAllSegments,
  resolveLoadersOnly,
} from "./segment-resolution/fresh.js";
export {
  resolveLoadersWithRevalidation,
  resolveLoadersOnlyWithRevalidation,
  buildEntryRevalidateMap,
  resolveParallelSegmentsWithRevalidation,
  resolveEntryHandlerWithRevalidation,
  resolveSegmentWithRevalidation,
  resolveOrphanLayoutWithRevalidation,
  resolveWithRevalidationErrorHandling,
  resolveAllSegmentsWithRevalidation,
} from "./segment-resolution/revalidation.js";
