/**
 * Public API for @rangojs/router/vite
 *
 * Exports: rango() plugin factory, poke() dev utility plugin,
 * and related option types. All other utilities are internal implementation
 * details consumed via direct imports within the package.
 */

export { rango } from "./rango.js";
export { poke } from "./plugins/refresh-cmd.js";
// The built-in clientChunks strategy, exported so a custom `clientChunks`
// function can OVERLAY it (route a few modules to a dedicated chunk, delegate
// the rest) instead of replacing the whole route/marker grouping. Without this
// a consumer override silently loses app-fallback/route splitting for the
// entire app. Note: called without a ClientChunkContext the fallbackRefs-based
// `app-fallback` split is inactive — discovery wires it only for the built-in.
export { directoryClientChunks } from "./utils/client-chunks.js";

export type {
  RangoNodeOptions,
  RangoCloudflareOptions,
  RangoVercelOptions,
  VercelPresetOptions,
  RangoOptions,
  ClientChunks,
  ClientChunkMeta,
  BuildEnvOption,
  BuildEnvFactory,
  BuildEnvFactoryContext,
  BuildEnvResult,
} from "./plugin-types.js";
