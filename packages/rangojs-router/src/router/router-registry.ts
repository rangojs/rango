import type { RSCRouter } from "./router-interfaces.js";

/**
 * Brand marker for identifying router instances at build time.
 * Used by the Vite plugin to auto-discover routers from module exports.
 */
export const RSC_ROUTER_BRAND = "__rsc_router__" as const;

/**
 * Global registry of all router instances created via createRouter().
 * Each router is keyed by its id (auto-generated or user-provided).
 * Used by the Vite plugin at build time to discover routers and extract
 * manifests, prefix trees, and pre-render candidates.
 */
export const RouterRegistry: Map<string, RSCRouter<any, any>> = new Map();

export let routerAutoId = 0;

export function nextRouterAutoId(): number {
  return routerAutoId++;
}
