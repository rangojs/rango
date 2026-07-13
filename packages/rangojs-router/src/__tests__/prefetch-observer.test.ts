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

  it("uses the current IntersectionObserver constructor after a test replaces it", async () => {
    let firstTrigger!: (entries: IntersectionObserverEntry[]) => void;
    const firstObserve = vi.fn();
    const firstDisconnect = vi.fn();
    class FirstIntersectionObserver {
      observe = firstObserve;
      unobserve = vi.fn();
      disconnect = firstDisconnect;

      constructor(callback: IntersectionObserverCallback) {
        firstTrigger = (entries) => callback(entries, this as any);
      }
    }
    vi.stubGlobal("IntersectionObserver", FirstIntersectionObserver);
    const { observeForPrefetch } = await import("../browser/prefetch/observer");
    const firstElement = {} as Element;
    const firstCallback = vi.fn();
    observeForPrefetch(firstElement, firstCallback);

    let secondTrigger!: (entries: IntersectionObserverEntry[]) => void;
    const secondObserve = vi.fn();
    class SecondIntersectionObserver {
      observe = secondObserve;
      unobserve = vi.fn();
      disconnect = vi.fn();

      constructor(callback: IntersectionObserverCallback) {
        secondTrigger = (entries) => callback(entries, this as any);
      }
    }
    vi.stubGlobal("IntersectionObserver", SecondIntersectionObserver);
    const secondElement = {} as Element;
    observeForPrefetch(secondElement, vi.fn());

    expect(firstDisconnect).toHaveBeenCalledOnce();
    expect(secondObserve).toHaveBeenCalledWith(firstElement);
    expect(secondObserve).toHaveBeenCalledWith(secondElement);

    const firstEntry = [
      {
        isIntersecting: true,
        target: firstElement,
      } as IntersectionObserverEntry,
    ];
    firstTrigger(firstEntry);
    expect(firstCallback).not.toHaveBeenCalled();
    secondTrigger(firstEntry);
    expect(firstCallback).toHaveBeenCalledOnce();
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

  it("stops a stale batch when an earlier callback replaces the observer", async () => {
    let trigger!: (entries: IntersectionObserverEntry[]) => void;
    const disconnect = vi.fn();
    class FirstIntersectionObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = disconnect;

      constructor(callback: IntersectionObserverCallback) {
        trigger = (entries) => callback(entries, this as any);
      }
    }
    vi.stubGlobal("IntersectionObserver", FirstIntersectionObserver);
    const { observeForPrefetch } = await import("../browser/prefetch/observer");
    const firstElement = {} as Element;
    const secondElement = {} as Element;
    const replacementElement = {} as Element;
    const secondCallback = vi.fn();
    observeForPrefetch(firstElement, () => {
      class SecondIntersectionObserver {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
      vi.stubGlobal("IntersectionObserver", SecondIntersectionObserver);
      observeForPrefetch(replacementElement, vi.fn());
    });
    observeForPrefetch(secondElement, secondCallback);

    trigger([
      {
        isIntersecting: true,
        target: firstElement,
      } as IntersectionObserverEntry,
      {
        isIntersecting: true,
        target: secondElement,
      } as IntersectionObserverEntry,
    ]);

    expect(disconnect).toHaveBeenCalledOnce();
    expect(secondCallback).not.toHaveBeenCalled();
  });

  it("does not re-observe detached elements after constructor replacement", async () => {
    class FirstIntersectionObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", FirstIntersectionObserver);
    const { observeForPrefetch } = await import("../browser/prefetch/observer");
    const detached = { isConnected: false } as Element;
    observeForPrefetch(detached, vi.fn());

    const secondObserve = vi.fn();
    class SecondIntersectionObserver {
      observe = secondObserve;
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", SecondIntersectionObserver);
    const connected = {} as Element;
    observeForPrefetch(connected, vi.fn());

    expect(secondObserve).not.toHaveBeenCalledWith(detached);
    expect(secondObserve).toHaveBeenCalledWith(connected);
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
    observeForPrefetch(element, () => {
      throw new Error("first failed");
    });
    observeForPrefetch(element, second);

    expect(() =>
      trigger([
        { isIntersecting: true, target: element } as IntersectionObserverEntry,
      ]),
    ).toThrow("first failed");
    expect(second).toHaveBeenCalledOnce();
  });
});
