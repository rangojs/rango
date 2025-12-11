/// <reference types="@cloudflare/workers-types" />
import * as rsc from "@vitejs/plugin-rsc/rsc";
import { router } from "./router.js";

export type { RscPayload } from "rsc-router/handler";

export interface Env {
  // Add your bindings here
  KV: KVNamespace;
}

const { fetch } = router.toFetchHandler<Env>({
  rsc,
  loadSSR: () =>
    import.meta.viteRsc.loadModule<typeof import("./entry.ssr.js")>(
      "ssr",
      "index"
    ),
});

export default {
  async fetch(request, env, ctx) {
    console.log("ctx", { ctx, env });

    const url = new URL(request.url);

    // Skip browser metadata requests
    if (
      url.pathname === "/favicon.ico" ||
      url.pathname.startsWith("/.well-known/")
    ) {
      return new Response(null, { status: 404 });
    }

    return fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
