import {
  renderToReadableStream,
  decodeReply,
  createTemporaryReferenceSet,
  loadServerAction,
} from "@vitejs/plugin-rsc/rsc";
import { createHandler } from "rsc-router/handler";
import { router } from "./router.js";

export type { RscPayload } from "rsc-router/handler";

export interface Env {
  // Add your bindings here
}

const handler = createHandler<Env>({
  router,
  rsc: {
    renderToReadableStream,
    decodeReply,
    createTemporaryReferenceSet,
    loadServerAction,
  },
  loadSSR: () =>
    import.meta.viteRsc.loadModule<typeof import("./entry.ssr.js")>(
      "ssr",
      "index"
    ),
});

// Export as Worker module for Cloudflare
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handler(request, env);
  },
} satisfies ExportedHandler<Env>;
