/**
 * Cloudflare preset integration surface for @rangojs/router.
 *
 * Imported via `@rangojs/router/cloudflare`. Cloudflare-only helpers live here
 * so Node/other-platform consumers never pull them in.
 */

export {
  createCloudflareTracing,
  type CloudflareTracingOptions,
} from "./tracing.js";
