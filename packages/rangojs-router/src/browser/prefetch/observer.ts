/**
 * Prefetch Observer
 *
 * Shared singleton IntersectionObserver for viewport-based prefetching.
 * One observer handles all Link components with prefetch="viewport".
 *
 * Lazy-created on first call to avoid issues in SSR or test environments
 * where IntersectionObserver may not exist.
 *
 * Observation is one-shot: once a link enters the viewport and the callback
 * fires, the element is unobserved. This prevents re-prefetching when a link
 * scrolls in and out repeatedly.
 */

import { notifyListeners } from "../notify-listeners.js";

type PrefetchCallback = () => void;

const callbacks = new Map<Element, Map<symbol, PrefetchCallback>>();
let observer: IntersectionObserver | null = null;

function getObserver(): IntersectionObserver {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries, currentObserver) => {
        function* intersectingCallbacks(): Generator<
          [Map<symbol, PrefetchCallback>, symbol, PrefetchCallback]
        > {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const subscriptions = callbacks.get(entry.target);
              if (subscriptions) {
                currentObserver.unobserve(entry.target);
                callbacks.delete(entry.target);
                for (const [subscription, callback] of subscriptions) {
                  yield [subscriptions, subscription, callback];
                }
              }
            }
          }
        }
        notifyListeners(
          intersectingCallbacks(),
          ([, , callback]) => callback(),
          ([subscriptions, subscription]) => subscriptions.has(subscription),
        );
      },
      { rootMargin: "200px" },
    );
    for (const element of callbacks.keys()) observer.observe(element);
  }
  return observer;
}

/** Reset module state between tests that replace browser observer globals. */
export function resetPrefetchObserverForTesting(): void {
  observer?.disconnect();
  observer = null;
  callbacks.clear();
}

/**
 * Observe an element for viewport intersection.
 * When the element becomes visible (within 200px margin), the callback fires
 * and the element is automatically unobserved.
 * No-op in environments without IntersectionObserver (SSR, some test runners).
 */
export function observeForPrefetch(
  element: Element,
  onVisible: PrefetchCallback,
): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  const currentObserver = getObserver();

  let subscriptions = callbacks.get(element);
  if (!subscriptions) {
    subscriptions = new Map();
    callbacks.set(element, subscriptions);
  }

  const subscription = Symbol();
  subscriptions.set(subscription, onVisible);
  if (subscriptions.size === 1) currentObserver.observe(element);

  return () => {
    const current = callbacks.get(element);
    subscriptions.delete(subscription);
    if (current !== subscriptions) return;
    if (current.size > 0) return;
    callbacks.delete(element);
    observer?.unobserve(element);
  };
}
