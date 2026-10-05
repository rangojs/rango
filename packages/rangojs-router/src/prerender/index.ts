/**
 * Public on-demand prerender surface (`@rangojs/router/prerender`).
 *
 * Store contracts, config/result/target types, and the in-memory store (usable
 * as a durable overlay in single-process node/Vercel functions, and as a test
 * fake). The Cloudflare KV adapter lives in `@rangojs/router/prerender/cloudflare`.
 */

export { PrerenderError } from "./create-prerender-trigger.js";

export {
  createMemoryPrerenderStore,
  type MemoryPrerenderStore,
  type MemoryPrerenderStoreOptions,
} from "./memory-prerender-store.js";

export {
  serializePrerenderKey,
  type PrerenderKey,
  type PrerenderStoredEntry,
  type WritablePrerenderStore,
} from "./writable-store.js";

export type {
  OnDemandOption,
  OnDemandRouteConfig,
  PrerenderConfig,
  PrerenderFn,
  PrerenderResult,
  PrerenderWarmCaches,
  PrerenderManyOptions,
  PrerenderRunner,
  PrerenderRunOptions,
  PrerenderRuntime,
  PrerenderTarget,
  PrerenderTargetObject,
} from "./on-demand.js";

export type { PrerenderEntry } from "./store.js";
