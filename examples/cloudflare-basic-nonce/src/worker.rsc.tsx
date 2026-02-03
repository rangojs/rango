/// <reference types="@cloudflare/workers-types" />
import { createRSCHandler } from "@rangojs/router/rsc";
import { router } from "./router.js";
import type { AppBindings } from "./env.js";

// Create handler with nonce support for CSP
// The CSP header is added by middleware in router.tsx
const handler = createRSCHandler({
  router,
  // Auto-generate a cryptographic nonce for each request
  nonce: () => true,
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

    // CSP headers are handled by middleware in router.tsx
    return handler(request, { Bindings: env, Variables: {} });
  },
} satisfies ExportedHandler<AppBindings>;
