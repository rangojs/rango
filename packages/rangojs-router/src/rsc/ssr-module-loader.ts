/**
 * The SSR module loader a handler created without `loadSSRModule` falls back
 * to in tests (`router.fetch` creates its handler that way). A leaf with no
 * runtime imports: testing/serve-shell-request.ts installs its stub here when
 * it loads, without importing rsc/handler.ts (which binds build-only virtual
 * modules a flight-only test config does not alias).
 */

import type { LoadSSRModule } from "./types.js";

let testLoader: LoadSSRModule | undefined;

/**
 * @internal Tests only: `router.prerender()` warms through `router.fetch`,
 * and the rsc Vitest project cannot run `import.meta.viteRsc.loadModule`.
 */
export function setDefaultSSRModuleLoaderForTests(
  loader: LoadSSRModule | undefined,
): void {
  testLoader = loader;
}

/** @internal Undefined everywhere but in tests. */
export function defaultSSRModuleLoaderForTests(): LoadSSRModule | undefined {
  return testLoader;
}
