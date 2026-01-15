import {
  renderToReadableStream,
  decodeReply,
  createTemporaryReferenceSet,
  loadServerAction,
  decodeAction,
  decodeFormState,
} from "rsc-router/internal/deps/rsc";
import { router, cacheStore } from "./router.js";
import { createRSCHandler } from "rsc-router/rsc";
import { VERSION } from "rsc-router:version";

export default createRSCHandler({
  router,
  version: VERSION,
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
