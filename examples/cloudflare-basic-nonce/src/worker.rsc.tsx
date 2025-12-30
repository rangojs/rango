/// <reference types="@cloudflare/workers-types" />
import { createRSCHandler } from "rsc-router/rsc";
import { router } from "./router.js";

export interface Env {
  // Add your bindings here
  KV: KVNamespace;
}

// Create handler with nonce support for CSP
const handler = createRSCHandler({
  router,
  // Auto-generate a cryptographic nonce for each request
  nonce: () => true,
});

// Build CSP header with nonce
function buildCSPHeader(nonce: string): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'unsafe-inline'`, // Inline styles for demo simplicity
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join("; ");
}

// Detect development mode by checking hostname
function isDevelopment(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
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

    const response = await handler(request, env);

    // Add CSP headers for HTML responses
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      // Get the nonce from the x-nonce header set by the handler
      const nonce = response.headers.get("x-nonce");

      if (nonce) {
        // Clone response to add CSP header
        const newHeaders = new Headers(response.headers);

        // Use Report-Only in dev mode to avoid blocking HMR scripts
        // Use enforcing CSP in production
        const cspHeaderName = isDevelopment(url)
          ? "Content-Security-Policy-Report-Only"
          : "Content-Security-Policy";

        newHeaders.set(cspHeaderName, buildCSPHeader(nonce));
        // Remove the internal x-nonce header
        newHeaders.delete("x-nonce");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }
    }

    return response;
  },
} satisfies ExportedHandler<Env>;
