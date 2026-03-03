/**
 * Public API for @rangojs/router/vite
 *
 * Only the rango() plugin factory and its option types are part of the
 * public API. All other utilities are internal implementation details
 * consumed via direct imports within the package.
 */

export { rango } from "./rango.js";

export type {
  RangoNodeOptions,
  RangoCloudflareOptions,
  RangoOptions,
} from "./plugin-types.js";
