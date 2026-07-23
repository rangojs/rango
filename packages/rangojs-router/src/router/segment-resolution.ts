// Barrel re-export -- see segment-resolution/ for implementations.
export {
  handleHandlerResult,
  warnOnStreamedResponse,
  buildLoaderErrorContext,
} from "./segment-resolution/helpers.js";
export {
  resolveLoaders,
  type ResolveSegmentOptions,
  resolveSegment,
  resolveOrphanLayout,
  resolveParallelEntry,
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
  resolveAllSegmentsWithRevalidation,
} from "./segment-resolution/revalidation.js";
