/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import { router } from "./router.js";
import type { AppBindings } from "./env.js";

// Reproduces the `cloudflare:workers` discovery failure. Discovery imports this
// file in a Node temp Vite server; `cloudflare:` isn't resolvable there.
export class Counter extends DurableObject {
  async increment() {
    return 1;
  }
}

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
    // Use router.fetch directly - cache is configured in router with ctx from env
    // Response routes (path.text, urls.json) are handled by the router's short-circuit
    return router.fetch(request, { env, ctx });
  },
} satisfies ExportedHandler<AppBindings>;
