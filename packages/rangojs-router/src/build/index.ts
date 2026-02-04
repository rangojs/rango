/**
 * Build-time utilities for @rangojs/router
 *
 * @example Generate manifest programmatically
 * ```typescript
 * import { generateManifest, generateManifestCode } from "@rangojs/router/build";
 * import { urlpatterns } from "./urls";
 *
 * const manifest = generateManifest(urlpatterns);
 * const code = generateManifestCode(urlpatterns);
 * ```
 *
 * @example Use Vite plugin
 * ```typescript
 * import { rangoRouterPlugin } from "@rangojs/router/build";
 *
 * export default defineConfig({
 *   plugins: [
 *     rangoRouterPlugin({
 *       urlpatternsPath: "./src/urls.tsx",
 *     }),
 *   ],
 * });
 * ```
 */

export {
  generateManifest,
  generateManifestCode,
  type GeneratedManifest,
  type PrefixTreeNode,
} from "./generate-manifest.js";

export {
  rangoRouterPlugin,
  VIRTUAL_MANIFEST_ID,
  type RangoRouterPluginOptions,
} from "./vite-plugin.js";
