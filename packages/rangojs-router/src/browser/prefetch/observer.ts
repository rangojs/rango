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

const callbacks = new Map<Element, PrefetchCallback>();
let observer: IntersectionObserver | null = null;

function getObserver(): IntersectionObserver {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const callback = callbacks.get(entry.target);
            if (callback) {
              observer!.unobserve(entry.target);
              callbacks.delete(entry.target);
              callback();
            }
          }
        }
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
): void {
  if (typeof IntersectionObserver === "undefined") return;
  callbacks.set(element, onVisible);
  getObserver().observe(element);
}

/**
 * Stop observing an element. Used for cleanup when a Link unmounts
 * before entering the viewport.
 */
export function unobserveForPrefetch(element: Element): void {
  callbacks.delete(element);
  if (observer) {
    observer.unobserve(element);
  }
}
