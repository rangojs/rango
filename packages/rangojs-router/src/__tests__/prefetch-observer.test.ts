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

    expect(observeForPrefetch({} as Element, vi.fn())).toEqual(
      expect.any(Function),
    );
  });

  it("resets module state before a test replaces IntersectionObserver", async () => {
    const firstObserve = vi.fn();
    const firstDisconnect = vi.fn();
    class FirstIntersectionObserver {
      observe = firstObserve;
      unobserve = vi.fn();
      disconnect = firstDisconnect;
    }
    vi.stubGlobal("IntersectionObserver", FirstIntersectionObserver);
    const { observeForPrefetch, resetPrefetchObserverForTesting } =
      await import("../browser/prefetch/observer");
    const firstElement = {} as Element;
    observeForPrefetch(firstElement, vi.fn());

    resetPrefetchObserverForTesting();

    const secondObserve = vi.fn();
    class SecondIntersectionObserver {
      observe = secondObserve;
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", SecondIntersectionObserver);
    const secondElement = {} as Element;
    observeForPrefetch(secondElement, vi.fn());

    expect(firstDisconnect).toHaveBeenCalledOnce();
    expect(secondObserve).toHaveBeenCalledWith(secondElement);
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

    const { observeForPrefetch } = await import("../browser/prefetch/observer");

    const callback = vi.fn();
    const element = {} as Element;

    const cleanup = observeForPrefetch(element, callback);
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

    cleanup();
    expect(instance.unobserve).toHaveBeenCalledTimes(1);
  });

  it("keeps another subscription active when one owner cleans up", async () => {
    let trigger!: (entries: IntersectionObserverEntry[]) => void;
    const unobserve = vi.fn();

    class MockIntersectionObserver {
      observe = vi.fn();
      unobserve = unobserve;

      constructor(callback: IntersectionObserverCallback) {
        trigger = (entries) => callback(entries, this as any);
      }
    }

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const { observeForPrefetch } = await import("../browser/prefetch/observer");
    const element = {} as Element;
    const first = vi.fn();
    const second = vi.fn();

    const cleanupFirst = observeForPrefetch(element, first);
    observeForPrefetch(element, second);
    cleanupFirst();

    expect(unobserve).not.toHaveBeenCalled();
    trigger([
      { isIntersecting: true, target: element } as IntersectionObserverEntry,
    ]);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(unobserve).toHaveBeenCalledWith(element);
  });

  it("does not notify an owner removed by an earlier callback", async () => {
    let trigger!: (entries: IntersectionObserverEntry[]) => void;

    class MockIntersectionObserver {
      observe = vi.fn();
      unobserve = vi.fn();

      constructor(callback: IntersectionObserverCallback) {
        trigger = (entries) => callback(entries, this as any);
      }
    }

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const { observeForPrefetch } = await import("../browser/prefetch/observer");
    const element = {} as Element;
    let cleanupSecond!: () => void;
    const second = vi.fn();
    observeForPrefetch(element, () => cleanupSecond());
    cleanupSecond = observeForPrefetch(element, second);

    trigger([
      { isIntersecting: true, target: element } as IntersectionObserverEntry,
    ]);

    expect(second).not.toHaveBeenCalled();
  });

  it("notifies every owner when an earlier callback throws", async () => {
    let trigger!: (entries: IntersectionObserverEntry[]) => void;

    class MockIntersectionObserver {
      observe = vi.fn();
      unobserve = vi.fn();

      constructor(callback: IntersectionObserverCallback) {
        trigger = (entries) => callback(entries, this as any);
      }
    }

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const { observeForPrefetch } = await import("../browser/prefetch/observer");
    const element = {} as Element;
    const second = vi.fn();
    const error = new Error("first failed");
    observeForPrefetch(element, () => {
      throw error;
    });
    observeForPrefetch(element, second);

    let thrown: unknown;
    try {
      trigger([
        { isIntersecting: true, target: element } as IntersectionObserverEntry,
      ]);
    } catch (current) {
      thrown = current;
    }
    expect(thrown).toBe(error);
    expect(second).toHaveBeenCalledOnce();
  });

  it("aggregates every owner error after notifying the full fan-out", async () => {
    let trigger!: (entries: IntersectionObserverEntry[]) => void;

    class MockIntersectionObserver {
      observe = vi.fn();
      unobserve = vi.fn();

      constructor(callback: IntersectionObserverCallback) {
        trigger = (entries) => callback(entries, this as any);
      }
    }

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const { observeForPrefetch } = await import("../browser/prefetch/observer");
    const element = {} as Element;
    const firstError = new Error("first failed");
    const secondError = new Error("second failed");
    const third = vi.fn();
    observeForPrefetch(element, () => {
      throw firstError;
    });
    observeForPrefetch(element, () => {
      throw secondError;
    });
    observeForPrefetch(element, third);

    let thrown: unknown;
    try {
      trigger([
        { isIntersecting: true, target: element } as IntersectionObserverEntry,
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      firstError,
      secondError,
    ]);
    expect(third).toHaveBeenCalledOnce();
  });
});
