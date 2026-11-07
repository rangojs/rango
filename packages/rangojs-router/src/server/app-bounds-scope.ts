/**
 * The app bounds (src/app-bounds.ts) of the request running here, read once by
 * the app's RSC handler onto its request context (rsc/handler.ts
 * `_appBounds`). The host router sets them (host/app-bounds.ts
 * runWithAppBounds) around the matched route's middleware and handler: an
 * AsyncLocalStorage scope rather than a field of the handler's `input` or of
 * the Request, since a consumer's handler may pass the app a new `input` or a
 * new Request, and the scope survives both.
 *
 * Both sides reach one AsyncLocalStorage through a global symbol and share no
 * module: a module the host entry and a router both import lands in a chunk
 * the router's cache version covers, and a change to the host entry would
 * then move every app's version (vite/__tests__/cache-versions-build.test.ts).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AppBounds } from "../app-bounds.js";

const appBoundsALS: AsyncLocalStorage<AppBounds> = ((globalThis as any)[
  Symbol.for("rangojs-router:app-bounds")
] ??= new AsyncLocalStorage<AppBounds>());

/**
 * The bounds of the request running here. Undefined when no host router
 * dispatched it, or every one let the app own all paths.
 */
export function currentAppBounds(): AppBounds | undefined {
  return appBoundsALS.getStore();
}
