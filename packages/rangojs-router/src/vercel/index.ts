/**
 * Vercel preset integration surface for @rangojs/router.
 *
 * Imported via `@rangojs/router/vercel`. Vercel-only helpers live here so
 * Node/other-platform consumers never pull them in. The Vercel cache store
 * (`VercelCacheStore`) is exported from `@rangojs/router/cache`, mirroring the
 * Cloudflare split where the store lives in `/cache` and the tracing helper in
 * the platform subpath.
 */

export { createVercelTracing, type VercelTracingOptions } from "./tracing.js";
