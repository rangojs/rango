// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefetchObserver = vi.hoisted(() => ({
  callbacks: new Map<Element, () => void>(),
  observeForPrefetch: vi.fn((element: Element, callback: () => void) => {
    prefetchObserver.callbacks.set(element, callback);
    return () => prefetchObserver.callbacks.delete(element);
  }),
}));

vi.mock("../browser/prefetch/observer.js", () => ({
  observeForPrefetch: prefetchObserver.observeForPrefetch,
}));

import {
  type DelegatedPrefetchCallback,
  setupDelegatedLinkPrefetch,
  setupLinkInterception,
} from "../browser/link-interceptor.js";
import { setDefaultPrefetchStrategy } from "../browser/prefetch/default-strategy.js";

let location: URL;
let stateListeners: Set<() => void>;

function setupPrefetch(
  onPrefetch: DelegatedPrefetchCallback,
  defaultPrefetch?: "none" | "viewport",
  basename?: string,
): () => void {
  const eventController = {
    getState: () => ({ location }),
    subscribe: (listener: () => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  } as unknown as Parameters<
    typeof setupDelegatedLinkPrefetch
  >[1]["eventController"];
  return setupDelegatedLinkPrefetch(onPrefetch, {
    eventController,
    defaultPrefetch,
    basename,
  });
}

describe("delegated plain-anchor prefetch", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    prefetchObserver.callbacks.clear();
    vi.clearAllMocks();
    location = new URL(window.location.href);
    stateListeners = new Set();
  });

  afterEach(() => {
    setDefaultPrefetchStrategy("none");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not start prefetch observation with click interception", () => {
    setDefaultPrefetchStrategy("viewport");
    document.body.innerHTML = `<a href="/target">target</a>`;

    const cleanup = setupLinkInterception(vi.fn());

    expect(prefetchObserver.observeForPrefetch).not.toHaveBeenCalled();
    cleanup();
  });

  it("observes eligible anchors except explicit opt-outs", () => {
    setDefaultPrefetchStrategy("viewport");
    document.body.innerHTML = `
      <a href="/target" data-testid="plain">plain</a>
      <a href="/side-effect" data-prefetch="false">opted-out side effect</a>
      <a href="/ignored" data-link-component>Link</a>
      <a href="/reload" data-no-intercept="true">reload</a>
    `;
    const plain = document.querySelector<HTMLAnchorElement>(
      '[data-testid="plain"]',
    )!;
    const onPrefetch = vi.fn<DelegatedPrefetchCallback>();

    const cleanup = setupPrefetch(onPrefetch);

    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledTimes(1);
    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
      plain,
      expect.any(Function),
    );

    prefetchObserver.callbacks.get(plain)!();
    expect(onPrefetch).toHaveBeenCalledWith(plain.href, "queued");

    cleanup();
  });

  it("uses an instance strategy without reading the module default", () => {
    setDefaultPrefetchStrategy("none");
    const link = document.createElement("a");
    link.href = "/target";
    document.body.appendChild(link);

    const cleanup = setupPrefetch(
      vi.fn<DelegatedPrefetchCallback>(),
      "viewport",
    );

    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
      link,
      expect.any(Function),
    );
    cleanup();
  });

  it("skips static resources and paths outside the router basename", () => {
    document.body.innerHTML = `
      <a href="/app/files/report.pdf" data-testid="asset">asset</a>
      <a href="/app/files/report%2Epdf" data-testid="encoded-asset">encoded asset</a>
      <a href="/app/report%ZZ" data-testid="malformed-path">malformed path</a>
      <a href="/sibling/page" data-testid="sibling">sibling app</a>
      <a href="/app/report.data" data-testid="route">suffix route</a>
    `;
    const route = document.querySelector<HTMLAnchorElement>(
      '[data-testid="route"]',
    )!;

    const cleanup = setupPrefetch(vi.fn(), "viewport", "/app");

    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledOnce();
    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
      route,
      expect.any(Function),
    );
    cleanup();
  });

  it("observes plain anchors inserted after prefetch is registered", async () => {
    setDefaultPrefetchStrategy("viewport");
    const onPrefetch = vi.fn<DelegatedPrefetchCallback>();
    const cleanup = setupPrefetch(onPrefetch);
    const link = document.createElement("a");
    link.href = "/dynamic";

    document.body.appendChild(link);
    await vi.waitFor(() => {
      expect(prefetchObserver.callbacks.has(link)).toBe(true);
    });

    prefetchObserver.callbacks.get(link)!();
    expect(onPrefetch).toHaveBeenCalledWith(link.href, "queued");

    cleanup();
  });

  it("does not re-register an anchor discovered for the next location", async () => {
    setDefaultPrefetchStrategy("viewport");
    const cleanup = setupPrefetch(vi.fn<DelegatedPrefetchCallback>());
    location = new URL("/another-page", location);
    const link = document.createElement("a");
    link.href = "/dynamic";

    document.body.appendChild(link);
    await vi.waitFor(() => {
      expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledTimes(1);
    });
    stateListeners.forEach((listener) => listener());

    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("upgrades a pending viewport prefetch when the pointer enters", () => {
    setDefaultPrefetchStrategy("viewport");
    const link = document.createElement("a");
    link.href = "/target";
    document.body.appendChild(link);
    const cancelPending = vi.fn();
    const onPrefetch = vi
      .fn<DelegatedPrefetchCallback>()
      .mockReturnValueOnce(cancelPending)
      .mockReturnValueOnce(undefined);
    const cleanup = setupPrefetch(onPrefetch);

    prefetchObserver.callbacks.get(link)!();
    link.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        relatedTarget: document.body,
      }),
    );

    expect(cancelPending).toHaveBeenCalledOnce();
    expect(onPrefetch).toHaveBeenNthCalledWith(2, link.href, "direct");

    cleanup();
  });

  it("re-observes persistent same-page anchors after SPA navigation", () => {
    setDefaultPrefetchStrategy("viewport");
    const link = document.createElement("a");
    link.href = `${location.pathname}#faq`;
    document.body.appendChild(link);
    const cleanup = setupPrefetch(vi.fn<DelegatedPrefetchCallback>());

    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledTimes(1);
    prefetchObserver.callbacks.get(link)!();

    location = new URL("/another-page", location);
    stateListeners.forEach((listener) => listener());

    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("re-runs render prefetch for persistent anchors after SPA navigation", () => {
    setDefaultPrefetchStrategy("render");
    const link = document.createElement("a");
    link.href = `${location.pathname}#faq`;
    document.body.appendChild(link);
    const onPrefetch = vi.fn<DelegatedPrefetchCallback>();
    const cleanup = setupPrefetch(onPrefetch);

    expect(onPrefetch).toHaveBeenCalledOnce();

    location = new URL("/another-page", location);
    stateListeners.forEach((listener) => listener());

    expect(onPrefetch).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("switches adaptive anchors from hover to viewport", () => {
    let hoverNone = false;
    let notifyChange: (() => void) | undefined;
    const observeMutations = vi.fn();
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe = observeMutations;
        disconnect = vi.fn();
      },
    );
    vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          get matches() {
            return hoverNone;
          },
          addEventListener: (_type: string, listener: () => void) => {
            notifyChange = listener;
          },
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    setDefaultPrefetchStrategy("adaptive");
    const link = document.createElement("a");
    link.href = "/target";
    document.body.appendChild(link);
    const cleanup = setupPrefetch(vi.fn<DelegatedPrefetchCallback>());

    expect(prefetchObserver.observeForPrefetch).not.toHaveBeenCalled();
    expect(observeMutations).not.toHaveBeenCalled();

    hoverNone = true;
    notifyChange!();
    expect(observeMutations).toHaveBeenCalledOnce();
    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
      link,
      expect.any(Function),
    );
    cleanup();
  });
});
