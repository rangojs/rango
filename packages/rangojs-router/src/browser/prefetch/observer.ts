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

type PrefetchCallback = () => void;

const callbacks = new Map<Element, Map<symbol, PrefetchCallback>>();
let observer: IntersectionObserver | null = null;

function getObserver(): IntersectionObserver {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        let callbackError: unknown;
        let callbackFailed = false;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const subscriptions = callbacks.get(entry.target);
            if (subscriptions) {
              observer!.unobserve(entry.target);
              callbacks.delete(entry.target);
              for (const callback of [...subscriptions.values()]) {
                try {
                  callback();
                } catch (error) {
                  if (!callbackFailed) callbackError = error;
                  callbackFailed = true;
                }
              }
            }
          }
        }
        if (callbackFailed) throw callbackError;
      },
      { rootMargin: "200px" },
    );
  }
  return observer;
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

  let subscriptions = callbacks.get(element);
  if (!subscriptions) {
    subscriptions = new Map();
    callbacks.set(element, subscriptions);
  }

  const subscription = Symbol();
  subscriptions.set(subscription, onVisible);
  if (subscriptions.size === 1) getObserver().observe(element);

  return () => {
    const current = callbacks.get(element);
    if (!current) return;
    current.delete(subscription);
    if (current.size > 0) return;
    callbacks.delete(element);
    observer?.unobserve(element);
  };
}
