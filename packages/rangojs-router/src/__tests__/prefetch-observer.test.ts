import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("prefetch observer", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is a no-op when IntersectionObserver is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);

    const { observeForPrefetch } = await import("../browser/prefetch/observer");

    expect(() => observeForPrefetch({} as Element, vi.fn())).not.toThrow();
  });

  it("fires callback once and unobserves on first intersection", async () => {
    let instance: any = null;

    class MockIntersectionObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      private callback: IntersectionObserverCallback;

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        instance = {
          trigger: (entries: IntersectionObserverEntry[]) =>
            this.callback(entries, this as any),
          observe: this.observe,
          unobserve: this.unobserve,
        };
      }
    }

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    const { observeForPrefetch, unobserveForPrefetch } =
      await import("../browser/prefetch/observer");

    const callback = vi.fn();
    const element = {} as Element;

    observeForPrefetch(element, callback);
    expect(instance.observe).toHaveBeenCalledWith(element);

    instance.trigger([
      {
        isIntersecting: true,
        target: element,
      } as IntersectionObserverEntry,
    ]);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(instance.unobserve).toHaveBeenCalledWith(element);

    instance.trigger([
      {
        isIntersecting: true,
        target: element,
      } as IntersectionObserverEntry,
    ]);
    expect(callback).toHaveBeenCalledTimes(1);

    unobserveForPrefetch(element);
    expect(instance.unobserve).toHaveBeenCalledWith(element);
  });
});
