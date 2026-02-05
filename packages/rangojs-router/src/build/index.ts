/**
 * Build-time utilities for @rangojs/router
 *
 * Note: Build-time manifest generation is optional. For most apps,
 * use runtime manifest caching via the `manifestCache` option instead:
 *
 * ```typescript
 * router.fetch(request, {
 *   manifestCache: true, // Memory-only caching
 * });
 * ```
 *
 * @example Generate manifest programmatically (for custom tooling)
 * ```typescript
 * import { generateManifest } from "@rangojs/router/build";
 * import { urlpatterns } from "./urls";
 *
 * const manifest = generateManifest(urlpatterns);
 * console.log(manifest.routeManifest); // { home: "/", about: "/about", ... }
 * ```
 */

export {
  generateManifest,
  generateManifestCode,
  type GeneratedManifest,
} from "./generate-manifest.js";
