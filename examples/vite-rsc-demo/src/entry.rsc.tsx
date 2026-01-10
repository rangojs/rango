import {
  renderToReadableStream,
  decodeReply,
  decodeAction,
  decodeFormState,
  createTemporaryReferenceSet,
  loadServerAction,
} from "rsc-router/internal/deps/rsc";
import { router } from "./router.js";
import { createRSCHandler } from "rsc-router/rsc";

export default createRSCHandler({
  router,
  deps: {
    renderToReadableStream,
    decodeReply,
    decodeAction,
    decodeFormState,
    createTemporaryReferenceSet,
    loadServerAction,
  },
  loadSSRModule: () =>
    import.meta.viteRsc.loadModule<typeof import("./entry.ssr.js")>(
      "ssr",
      "index"
    ),
});
