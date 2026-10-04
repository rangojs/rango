import { notifyListeners } from "../notify-listeners.js";

type PrefetchCacheInvalidationListener = () => void;

const listeners = new Map<symbol, PrefetchCacheInvalidationListener>();

/** Subscribe to completed local prefetch-cache invalidations. */
export function subscribeToPrefetchCacheInvalidation(
  listener: PrefetchCacheInvalidationListener,
): () => void {
  const subscription = Symbol();
  listeners.set(subscription, listener);

  return () => listeners.delete(subscription);
}

/** Notify the registrations that existed when the cache was invalidated. */
export function notifyPrefetchCacheInvalidated(): void {
  const registrations = [...listeners];
  // Finish the current broadcast/action finalizer before re-arming work. A
  // synchronous callback could throw before cross-tab invalidation is sent or
  // prefetch while the action fence is still raised.
  queueMicrotask(() => {
    notifyListeners(
      registrations,
      ([, listener]) => listener(),
      ([subscription, listener]) => listeners.get(subscription) === listener,
    );
  });
}
