import type { ReactNode } from "react";

const IS_BROWSER = typeof window !== "undefined";

/**
 * What a RouteContentWrapper receives as `content`.
 *
 * Browser: a component that is not already a promise is handed over as the
 * node itself, which Suspender renders without `use()`. It was a memoized
 * `Promise.resolve(component)`, which React knows as fulfilled only after it
 * has read it. A boundary on screen that had been rendered with the node (a
 * forceAwait commit: a prefetched click, popstate) and was next handed a
 * promise it had not read, in a render that cannot wait, showed its loading()
 * fallback over content it held for 300 ms.
 *
 * Server: a fresh `Promise.resolve(component)` per call. A shared resolved
 * promise would carry React's `.status` across requests and skip the Suspense
 * fallback in the streamed HTML.
 *
 * A component that is already a promise (a Flight-streamed segment) is
 * returned as is in both environments.
 *
 * @internal
 */
export function getMemoizedContentPromise(
  component: ReactNode,
): Promise<ReactNode> | ReactNode {
  if (component instanceof Promise) {
    return component as Promise<ReactNode>;
  }
  return IS_BROWSER ? component : Promise.resolve(component);
}
