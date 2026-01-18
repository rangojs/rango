import {
  renderToReadableStream,
  decodeReply,
  createTemporaryReferenceSet,
  loadServerAction,
  decodeAction,
  decodeFormState,
} from "rsc-router/internal/deps/rsc";
import { router } from "./router.js";
import { createRSCHandler } from "rsc-router/rsc";

// Import loader manifest to ensure all fetchable loaders are registered at startup
import "virtual:rsc-router/loader-manifest";

// Cache is configured on the router (see router.tsx)
// VERSION is auto-imported by createRSCHandler
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
  // Enable shell caching for fast TTFB
  // Requires x-enable-ppr header (typically set by CDN) or __force_ppr query param for dev
  shell: {
    enabled: true,
    shouldCache: (ctx) =>
      ctx.request.headers.has("x-enable-ppr") ||
      ctx.url.searchParams.has("__force_ppr"),
  },
});
