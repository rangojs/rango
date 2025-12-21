/// <reference types="@cloudflare/workers-types" />
import { createRSCHandler } from "rsc-router/rsc";
import * as rsc from "@vitejs/plugin-rsc/rsc";
import { router } from "./router.js";

export interface Env {
  // Add your bindings here
  KV: KVNamespace;
}

const handler = createRSCHandler({
  router,
  deps: rsc,
  loadSSRModule: () => import.meta.viteRsc.loadModule("ssr", "index"),
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Skip browser metadata requests
    if (
      url.pathname === "/favicon.ico" ||
      url.pathname.startsWith("/.well-known/")
    ) {
      return new Response(null, { status: 404 });
    }

    return handler(request, env);
  },
} satisfies ExportedHandler<Env>;
