/**
 * Public on-demand prerender surface (`@rangojs/router/prerender`).
 *
 * Store contracts, config/result/target types, and the in-memory store (usable
 * as a durable overlay in single-process node/Vercel functions, and as a test
 * fake). The Cloudflare KV adapter lives in `@rangojs/router/prerender/cloudflare`.
 */

export {
  createMemoryPrerenderStore,
  type MemoryPrerenderStore,
  type MemoryPrerenderStoreOptions,
} from "./memory-prerender-store.js";

export {
  serializePrerenderKey,
  type PrerenderKey,
  type PrerenderLookupMeta,
  type PrerenderSetOptions,
  type PrerenderStoredEntry,
  type WritablePrerenderStore,
} from "./writable-store.js";

export type {
  OnDemandOption,
  OnDemandRouteConfig,
  PrerenderConfig,
  PrerenderFn,
  PrerenderResult,
  PrerenderRuntime,
  PrerenderRuntimeBase,
  PrerenderManyRuntime,
  PrerenderTarget,
  PrerenderTargetObject,
  ResolvedPrerender,
} from "./on-demand.js";

export type { PrerenderEntry } from "./store.js";
