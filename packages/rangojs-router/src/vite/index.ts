/**
 * Public API for @rangojs/router/vite
 *
 * Exports: rango() plugin factory, poke() dev utility plugin,
 * and related option types. All other utilities are internal implementation
 * details consumed via direct imports within the package.
 */

export { rango } from "./rango.js";
export { poke } from "./plugins/refresh-cmd.js";

export type {
  RangoNodeOptions,
  RangoCloudflareOptions,
  RangoOptions,
  BuildEnvOption,
  BuildEnvFactory,
  BuildEnvFactoryContext,
  BuildEnvResult,
} from "./plugin-types.js";
