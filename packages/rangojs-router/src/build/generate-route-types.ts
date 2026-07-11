// Barrel re-export -- see route-types/ for implementations.
export {
  extractParamsFromPattern,
  formatRouteEntry,
} from "./route-types/param-extraction.js";
export { extractRoutesFromSource } from "./route-types/ast-route-extraction.js";
export {
  generatePerModuleTypesSource,
  generateRouteTypesSource,
} from "./route-types/codegen.js";
export {
  DEFAULT_EXCLUDE_PATTERNS,
  type ScanFilter,
  createScanFilter,
  findTsFiles,
} from "./route-types/scan-filter.js";
export {
  writePerModuleRouteTypes,
  writePerModuleRouteTypesForFile,
} from "./route-types/per-module-writer.js";
export {
  type UnresolvableReason,
  type UnresolvableInclude,
  extractIncludesWithDiagnostics,
} from "./route-types/include-resolution.js";
export {
  extractUrlsFromRouter,
  extractBasenameFromRouter,
  type UrlsExtractionResult,
  buildCombinedRouteMapForRouterFile,
  detectUnresolvableIncludes,
  detectUnresolvableIncludesForUrlsFile,
  findNestedRouterConflict,
  formatNestedRouterConflictError,
  findRouterFiles,
  findHostRouterFiles,
  writeCombinedRouteTypes,
  genFileTsPath,
  resolveSearchSchemas,
} from "./route-types/router-processing.js";
export { findUrlsVariableNames } from "./route-types/per-module-writer.js";
