/**
 * Client-side loader preparation.
 *
 * Before renderSegments() runs in the browser, segments flagged with
 * clientLoaderIds need their loaderData populated with Promises from
 * the client loader registry. The segment system's LoaderBoundary then
 * handles the Suspense lifecycle (showing loading() fallback until
 * the Promise resolves).
 *
 * This is synchronous — it starts execution but does NOT await results.
 * The Promises flow through the segment system's loaderDataPromise path.
 */

import type { ResolvedSegment, ClientLoaderContext, ServiceDefinition } from "../types.js";
import { getClientLoader, waitForClientLoader } from "./client-loader-registry.js";
import { getServiceInstance } from "./service-registry.js";

/**
 * Prepare client-side loaders by putting pending Promises into segment.loaderData.
 * Must be called before renderSegments() in the browser.
 *
 * For SPA navigation, client functions are already registered (modules loaded).
 * For post-hydration resolution, modules may still be loading — waitForClientLoader
 * creates a deferred Promise that resolves when the module registers.
 *
 * @param segments - All segments for the current navigation
 * @param url - The navigation target URL
 * @param signal - AbortSignal for cancellation
 */
export function prepareClientLoaders(
  segments: ResolvedSegment[],
  url: URL,
  signal?: AbortSignal,
  state?: Record<string, unknown> | null,
): void {
  if (typeof window === "undefined") return;

  const pendingSegments = segments.filter(
    (s) => s.clientLoaderIds && s.clientLoaderIds.length > 0,
  );

  if (pendingSegments.length === 0) return;

  const effectiveSignal = signal ?? new AbortController().signal;

  for (const segment of pendingSegments) {
    const ctx: ClientLoaderContext = {
      params: segment.params ?? {},
      searchParams: url.searchParams,
      pathname: url.pathname,
      url,
      signal: effectiveSignal,
      segments: url.pathname.split("/").filter(Boolean),
      state: state ?? null,
      use: <TInit, TInstance>(service: ServiceDefinition<TInit, TInstance>): TInstance => {
        const instance = getServiceInstance(service.$$id);
        if (instance === undefined) {
          throw new Error(
            `Service "${service.$$id}" not initialized. ` +
            `Ensure service() is declared in the route definition and the module is imported.`,
          );
        }
        return instance;
      },
    };

    for (const loaderId of segment.clientLoaderIds!) {
      const clientFn = getClientLoader(loaderId);

      // Build the execution chain: use function directly if available,
      // otherwise wait for module registration (post-hydration scenario).
      const executionPromise = clientFn
        ? Promise.resolve(clientFn(ctx))
        : waitForClientLoader(loaderId, effectiveSignal).then((fn) => fn(ctx));

      // Put a pending Promise in loaderData (LoaderDataResult shape).
      // The segment system picks this up via the loaderEntries filter
      // (loaderData !== undefined) and passes it through LoaderBoundary.
      segment.loaderData = executionPromise.then((data) => ({
        __loaderResult: true,
        ok: true,
        data,
      }));
    }
  }
}
