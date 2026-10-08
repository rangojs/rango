import type { ReactNode } from "react";

const IS_BROWSER = typeof window !== "undefined";

/**
 * What a RouteContentWrapper receives as `content`.
 *
 * Browser: hand over the settled value. React treats a promise as fulfilled
 * only after it has read it, and a boundary on screen handed a promise it has
 * not read, in a render that cannot wait, shows its fallback. A component that
 * is already a promise (a Flight-streamed segment) is returned as is, since
 * it can really be pending.
 *
 * Server: a fresh `Promise.resolve(component)` per call, so Suspense emits the
 * fallback in the streamed HTML. A shared resolved promise would carry React's
 * `.status` across requests and skip it.
 *
 * @internal
 */
export function getBoundaryContent(component: ReactNode): ReactNode {
  if (component instanceof Promise || IS_BROWSER) {
    return component;
  }
  return Promise.resolve(component);
}
