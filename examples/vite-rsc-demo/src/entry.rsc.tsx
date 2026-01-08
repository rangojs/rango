import {
  renderToReadableStream,
  decodeReply,
  createTemporaryReferenceSet,
  loadServerAction,
  decodeAction,
  decodeFormState,
} from "rsc-router/internal/deps/rsc";
import { router } from "./router.js";
import { createRSCHandler, MemorySegmentCacheStore } from "rsc-router/rsc";

// Create cache store with defaults (persists across HMR via globalThis)
const cacheStore = new MemorySegmentCacheStore({
  defaults: {
    ttl: 60,  // Default TTL for all cache() boundaries
  },
});

export default createRSCHandler({
  router,
  deps: {
    renderToReadableStream,
    decodeReply,
    createTemporaryReferenceSet,
    loadServerAction,
    decodeAction,
    decodeFormState,
  },
  loadSSRModule: () =>
    import.meta.viteRsc.loadModule<typeof import("./entry.ssr.js")>(
      "ssr",
      "index"
    ),
  cache: {
    store: cacheStore,
  },
});
