/**
 * Resource Readiness
 *
 * Utilities to defer speculative prefetches until critical resources
 * (viewport images) have finished loading. Prevents prefetch fetch()
 * calls from competing with images for the browser's connection pool.
 */

/**
 * Resolve when all in-viewport images have finished loading.
 * Returns immediately if no images are pending.
 *
 * Only checks images that exist at call time — does not observe
 * dynamically added images. For SPA navigations where new images
 * appear after render, call this after the navigation settles.
 */
export function waitForViewportImages(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();

  const pending = Array.from(document.querySelectorAll("img")).filter((img) => {
    if (img.complete) return false;
    const rect = img.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  });

  if (pending.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    const settled = new Set<HTMLImageElement>();

    const settle = (img: HTMLImageElement) => {
      if (settled.has(img)) return;
      settled.add(img);
      if (settled.size >= pending.length) resolve();
    };

    for (const img of pending) {
      img.addEventListener("load", () => settle(img), { once: true });
      img.addEventListener("error", () => settle(img), { once: true });
      // Re-check: image may have completed between the initial filter
      // and listener attachment. settle() is idempotent per image, so
      // a queued load event firing afterward is harmless.
      if (img.complete) settle(img);
    }
  });
}

/**
 * Resolve after the given number of milliseconds.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve when the browser has an idle main-thread moment.
 * Uses requestIdleCallback where available, falls back to setTimeout.
 *
 * This is a scheduling hint, not an asset-loaded detector — combine
 * with waitForViewportImages() for full resource readiness.
 */
export function waitForIdle(timeout = 200): Promise<void> {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    return new Promise((resolve) => {
      window.requestIdleCallback(() => resolve(), { timeout });
    });
  }

  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
