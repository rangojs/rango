// Barrel re-export -- see segment-resolution/ for implementations.
export {
  handleHandlerResult,
  warnOnStreamedResponse,
  buildLoaderErrorContext,
} from "./segment-resolution/helpers.js";
export {
  resolveLoadersOnly,
  buildEntryRevalidateMap,
  resolveParallelSegments,
  resolveEntryHandler,
  resolveSegment,
  resolveOrphanLayout,
  resolveAllSegments,
} from "./segment-resolution/revalidation.js";
