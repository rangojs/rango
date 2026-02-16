/**
 * Client-side loader function registry.
 *
 * Stores client loader functions (from createClientLoader and
 * createIsomorphicLoader) so they can be looked up and executed
 * during SPA navigation in the browser.
 *
 * Populated at module load time when loader modules are imported.
 */

import type { ClientLoaderFn } from "../types.js";

const clientLoaderRegistry = new Map<string, ClientLoaderFn<any>>();
const pendingWaiters = new Map<string, Set<(fn: ClientLoaderFn<any>) => void>>();

export function registerClientLoader(
  id: string,
  fn: ClientLoaderFn<any>,
): void {
  clientLoaderRegistry.set(id, fn);

  // Notify any waiters (e.g. prepareClientLoaders during hydration
  // before the module has been imported by React)
  const waiters = pendingWaiters.get(id);
  if (waiters) {
    for (const cb of waiters) cb(fn);
    pendingWaiters.delete(id);
  }
}

export function getClientLoader(
  id: string,
): ClientLoaderFn<any> | undefined {
  return clientLoaderRegistry.get(id);
}

/**
 * Returns a Promise that resolves with the client loader function
 * once it's registered. If already registered, resolves immediately.
 *
 * Used during hydration when prepareClientLoaders runs before React
 * has imported the client modules that register loader functions.
 */
export function waitForClientLoader(
  id: string,
  signal?: AbortSignal,
): Promise<ClientLoaderFn<any>> {
  const fn = clientLoaderRegistry.get(id);
  if (fn) return Promise.resolve(fn);

  return new Promise((resolve, reject) => {
    if (!pendingWaiters.has(id)) pendingWaiters.set(id, new Set());

    const cb = (fn: ClientLoaderFn<any>) => {
      clearTimeout(timer);
      resolve(fn);
    };

    const cleanup = () => {
      clearTimeout(timer);
      const waiters = pendingWaiters.get(id);
      if (waiters) {
        waiters.delete(cb);
        if (waiters.size === 0) pendingWaiters.delete(id);
      }
    };

    // Safety-net timeout: reject if the module never registers the loader
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Client loader "${id}" was not registered within 10 seconds. ` +
        `Ensure the loader module is imported in the client bundle.`,
      ));
    }, 10_000);

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new DOMException("Client loader wait aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => {
        cleanup();
        reject(new DOMException("Client loader wait aborted", "AbortError"));
      }, { once: true });
    }

    pendingWaiters.get(id)!.add(cb);
  });
}
