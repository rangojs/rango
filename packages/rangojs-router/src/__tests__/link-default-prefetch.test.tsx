// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Mock the prefetch executors and the viewport observer so the test asserts
// WHICH strategy the Link resolved (did it enqueue?) without any network or
// IntersectionObserver machinery. observeForPrefetch invokes its callback
// synchronously — the element is "in viewport" the moment it's observed.
vi.mock("../browser/prefetch/loader.js", () => ({
  prefetchDirect: vi.fn(),
  prefetchQueued: vi.fn(() => "key"),
  schedulePrefetchWhenRouterIdle: vi.fn(
    (_eventController: unknown, callback: () => void) => callback(),
  ),
}));

const prefetchObserver = vi.hoisted(() => ({
  cleanup: vi.fn(),
  observe: vi.fn((_el: Element, callback: () => void) => {
    callback();
    return prefetchObserver.cleanup;
  }),
}));

vi.mock("../browser/prefetch/observer.js", () => ({
  observeForPrefetch: prefetchObserver.observe,
}));

import { prefetchDirect, prefetchQueued } from "../browser/prefetch/loader.js";
import { Link } from "../browser/react/Link.js";
import { NavigationStoreContext } from "../browser/react/context.js";
import type { NavigationStoreContextValue } from "../browser/react/context.js";
import {
  setDefaultPrefetchStrategy,
  getDefaultPrefetchStrategy,
} from "../browser/prefetch/default-strategy.js";
import { subscribeToPrefetchScopeChange } from "../browser/link-interceptor.js";
import { DEFAULT_PREFETCH_STRATEGY } from "../router/prefetch-default.js";

let location: URL;
let stateListeners: Set<() => void>;

const ctxValue = {
  store: {
    getSegmentState: () => ({ currentSegmentIds: [] }),
    getRouterId: () => "router_test",
  },
  eventController: {
    getState: () => ({ state: "idle", isStreaming: false, location }),
    subscribe: (listener: () => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  },
  navigate: async () => {},
  refresh: async () => {},
  version: undefined,
  basename: undefined,
} as unknown as NavigationStoreContextValue;

let container: HTMLDivElement;
let root: Root;
let rootMounted: boolean;

function renderLink(props: { to: string; prefetch?: "viewport" | "none" }) {
  act(() => {
    root.render(
      <NavigationStoreContext.Provider value={ctxValue}>
        <Link to={props.to} prefetch={props.prefetch}>
          target
        </Link>
      </NavigationStoreContext.Provider>,
    );
  });
}

describe("Link default prefetch fallback", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    rootMounted = true;
    location = new URL(window.location.href);
    stateListeners = new Set();
    ctxValue.defaultPrefetch = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (rootMounted) act(() => root.unmount());
    container.remove();
    setDefaultPrefetchStrategy(DEFAULT_PREFETCH_STRATEGY);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a bare Link stays quiet under the built-in development default", () => {
    expect(getDefaultPrefetchStrategy()).toBe("none");
    renderLink({ to: "/target" });
    expect(prefetchQueued).not.toHaveBeenCalled();
  });

  it("a bare Link viewport-prefetches under an explicit production strategy", () => {
    setDefaultPrefetchStrategy("viewport");
    renderLink({ to: "/target" });
    expect(prefetchQueued).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prefetchQueued).mock.calls[0][0]).toBe("/target");
  });

  it("does not arm or hover-prefetch a same-page hash Link", () => {
    ctxValue.defaultPrefetch = "viewport";
    renderLink({
      to: `${window.location.pathname}${window.location.search}#section`,
    });

    expect(prefetchObserver.observe).not.toHaveBeenCalled();
    expect(prefetchQueued).not.toHaveBeenCalled();
    act(() => {
      container
        .querySelector("a")!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(prefetchDirect).not.toHaveBeenCalled();
  });

  it("does not prefetch a Link inside a disabled container scope", () => {
    act(() => {
      root.render(
        <NavigationStoreContext.Provider value={ctxValue}>
          <section data-prefetch-scope="none">
            <Link to="/scoped" prefetch="viewport" data-testid="scoped-link">
              scoped
            </Link>
          </section>
          <Link to="/outside" prefetch="viewport">
            outside
          </Link>
        </NavigationStoreContext.Provider>,
      );
    });

    expect(prefetchQueued).toHaveBeenCalledOnce();
    expect(vi.mocked(prefetchQueued).mock.calls[0][0]).toBe("/outside");

    act(() => {
      container
        .querySelector<HTMLAnchorElement>('[data-testid="scoped-link"]')!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(prefetchDirect).not.toHaveBeenCalled();
  });

  it("accepts false as a Link container scope opt-out", () => {
    act(() => {
      root.render(
        <NavigationStoreContext.Provider value={ctxValue}>
          <section data-prefetch-scope="false">
            <Link to="/scoped" prefetch="viewport">
              scoped
            </Link>
          </section>
        </NavigationStoreContext.Provider>,
      );
    });

    expect(prefetchObserver.observe).not.toHaveBeenCalled();
    expect(prefetchQueued).not.toHaveBeenCalled();
  });

  it("re-arms a Link when its container scope is removed", async () => {
    act(() => {
      root.render(
        <NavigationStoreContext.Provider value={ctxValue}>
          <section data-prefetch-scope="none" data-testid="scope">
            <Link to="/scoped" prefetch="viewport">
              scoped
            </Link>
          </section>
          <section data-prefetch-scope="none">
            <Link to="/still-scoped" prefetch="viewport">
              still scoped
            </Link>
          </section>
        </NavigationStoreContext.Provider>,
      );
    });
    expect(prefetchQueued).not.toHaveBeenCalled();

    container
      .querySelector<HTMLElement>('[data-testid="scope"]')!
      .removeAttribute("data-prefetch-scope");

    await vi.waitFor(() => expect(prefetchQueued).toHaveBeenCalledOnce());
    expect(vi.mocked(prefetchQueued).mock.calls[0][0]).toBe("/scoped");
  });

  it("shares and releases one scope observer across Links", () => {
    const construct = vi.fn();
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe = observe;
        disconnect = disconnect;

        constructor(_callback: MutationCallback) {
          construct();
        }
      },
    );

    act(() => {
      root.render(
        <NavigationStoreContext.Provider value={ctxValue}>
          <Link to="/first" prefetch="viewport">
            first
          </Link>
          <Link to="/second" prefetch="viewport">
            second
          </Link>
        </NavigationStoreContext.Provider>,
      );
    });

    expect(construct).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();

    act(() => root.unmount());
    rootMounted = false;
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps a replacement scope subscription after stale cleanup", () => {
    let notify!: MutationCallback;
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();

        constructor(callback: MutationCallback) {
          notify = callback;
        }
      },
    );
    const link = document.createElement("a");
    const keepAlive = document.createElement("a");
    document.body.append(link, keepAlive);

    const staleCleanup = subscribeToPrefetchScopeChange(link, vi.fn());
    const cleanupKeepAlive = subscribeToPrefetchScopeChange(keepAlive, vi.fn());
    staleCleanup();
    const replacement = vi.fn();
    const cleanupReplacement = subscribeToPrefetchScopeChange(
      link,
      replacement,
    );

    staleCleanup();
    notify(
      [{ target: link } as unknown as MutationRecord],
      {} as MutationObserver,
    );

    cleanupReplacement();
    cleanupKeepAlive();
    expect(replacement).toHaveBeenCalledOnce();
  });

  it("notifies every affected scope listener before surfacing an error", () => {
    let notify!: MutationCallback;
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();

        constructor(callback: MutationCallback) {
          notify = callback;
        }
      },
    );
    const section = document.createElement("section");
    const first = document.createElement("a");
    const second = document.createElement("a");
    first.dataset.linkComponent = "";
    second.dataset.linkComponent = "";
    section.append(first, second);
    document.body.appendChild(section);
    const error = new Error("scope listener failed");
    const cleanupFirst = subscribeToPrefetchScopeChange(first, () => {
      throw error;
    });
    const secondListener = vi.fn();
    const cleanupSecond = subscribeToPrefetchScopeChange(
      second,
      secondListener,
    );

    let thrown: unknown;
    try {
      notify(
        [{ target: section } as unknown as MutationRecord],
        {} as MutationObserver,
      );
    } catch (caught) {
      thrown = caught;
    }

    cleanupFirst();
    cleanupSecond();
    expect(thrown).toBe(error);
    expect(secondListener).toHaveBeenCalledOnce();
  });

  it("uses an instance default without mutating the module default", () => {
    ctxValue.defaultPrefetch = "viewport";
    renderLink({ to: "/target" });

    expect(prefetchQueued).toHaveBeenCalledOnce();
    expect(getDefaultPrefetchStrategy()).toBe("none");
  });

  it.each(["viewport", "render"] as const)(
    "re-arms %s prefetch after the committed location changes",
    (strategy) => {
      ctxValue.defaultPrefetch = strategy;
      renderLink({ to: "/target" });
      expect(prefetchQueued).toHaveBeenCalledOnce();

      location = new URL("/another-page", location);
      stateListeners.forEach((listener) => listener());

      expect(prefetchQueued).toHaveBeenCalledTimes(2);
    },
  );

  it("an explicit prefetch prop wins over the router default in both directions", () => {
    // Opt OUT of an aggressive default.
    renderLink({ to: "/target", prefetch: "none" });
    expect(prefetchQueued).not.toHaveBeenCalled();

    // Opt IN under manual mode.
    setDefaultPrefetchStrategy("none");
    renderLink({ to: "/other", prefetch: "viewport" });
    expect(prefetchQueued).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prefetchQueued).mock.calls[0][0]).toBe("/other");
  });

  it("re-arms a mounted adaptive Link when input capability changes", () => {
    let hoverNone = false;
    const listeners = new Set<() => void>();
    vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          get matches() {
            return hoverNone;
          },
          addEventListener: (_type: string, listener: () => void) => {
            listeners.add(listener);
          },
          removeEventListener: (_type: string, listener: () => void) => {
            listeners.delete(listener);
          },
        }) as unknown as MediaQueryList,
    );
    ctxValue.defaultPrefetch = "adaptive";
    renderLink({ to: "/target" });
    expect(prefetchQueued).not.toHaveBeenCalled();

    hoverNone = true;
    act(() => listeners.forEach((listener) => listener()));

    expect(prefetchQueued).toHaveBeenCalledOnce();
    expect(vi.mocked(prefetchQueued).mock.calls[0][0]).toBe("/target");

    hoverNone = false;
    act(() => listeners.forEach((listener) => listener()));
    expect(prefetchObserver.cleanup).toHaveBeenCalledOnce();

    hoverNone = true;
    act(() => listeners.forEach((listener) => listener()));
    expect(prefetchQueued).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    rootMounted = false;
    expect(prefetchObserver.cleanup).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(0);
  });
});
