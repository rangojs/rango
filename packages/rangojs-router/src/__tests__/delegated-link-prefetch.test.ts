// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefetchLoader = vi.hoisted(() => ({
  callbacks: new Map<Element, () => void>(),
  observeForPrefetch: vi.fn((element: Element, callback: () => void) => {
    prefetchLoader.callbacks.set(element, callback);
    return () => prefetchLoader.callbacks.delete(element);
  }),
}));

vi.mock("../browser/prefetch/loader.js", () => ({
  observeForPrefetch: prefetchLoader.observeForPrefetch,
}));

import {
  type DelegatedPrefetchCallback,
  setupDelegatedLinkPrefetch,
  setupLinkInterception,
} from "../browser/link-interceptor.js";
import { setDefaultPrefetchStrategy } from "../browser/prefetch/default-strategy.js";

let location: URL;
let stateListeners: Set<() => void>;

function setupPrefetch(onPrefetch: DelegatedPrefetchCallback): () => void {
  const eventController = {
    getState: () => ({ location }),
    subscribe: (listener: () => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  } as unknown as Parameters<
    typeof setupDelegatedLinkPrefetch
  >[1]["eventController"];
  return setupDelegatedLinkPrefetch(onPrefetch, { eventController });
}

describe("delegated plain-anchor prefetch", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    prefetchLoader.callbacks.clear();
    vi.clearAllMocks();
    location = new URL(window.location.href);
    stateListeners = new Set();
  });

  afterEach(() => {
    setDefaultPrefetchStrategy("none");
    vi.restoreAllMocks();
  });

  it("does not start prefetch observation with click interception", () => {
    setDefaultPrefetchStrategy("viewport");
    document.body.innerHTML = `<a href="/target" data-prefetch="true">target</a>`;

    const cleanup = setupLinkInterception(vi.fn());

    expect(prefetchLoader.observeForPrefetch).not.toHaveBeenCalled();
    cleanup();
  });

  it("observes only explicitly opted-in eligible anchors", () => {
    setDefaultPrefetchStrategy("viewport");
    document.body.innerHTML = `
      <a href="/target" data-prefetch="true" data-testid="plain">plain</a>
      <a href="/side-effect">unmarked side effect</a>
      <a href="/ignored" data-prefetch="true" data-link-component>Link</a>
      <a href="/reload" data-prefetch="true" data-no-intercept="true">reload</a>
    `;
    const plain = document.querySelector<HTMLAnchorElement>(
      '[data-testid="plain"]',
    )!;
    const onPrefetch = vi.fn<DelegatedPrefetchCallback>();

    const cleanup = setupPrefetch(onPrefetch);

    expect(prefetchLoader.observeForPrefetch).toHaveBeenCalledTimes(1);
    expect(prefetchLoader.observeForPrefetch).toHaveBeenCalledWith(
      plain,
      expect.any(Function),
    );

    prefetchLoader.callbacks.get(plain)!();
    expect(onPrefetch).toHaveBeenCalledWith(plain.href, "queued");

    cleanup();
  });

  it("observes plain anchors inserted after prefetch is registered", async () => {
    setDefaultPrefetchStrategy("viewport");
    const onPrefetch = vi.fn<DelegatedPrefetchCallback>();
    const cleanup = setupPrefetch(onPrefetch);
    const link = document.createElement("a");
    link.href = "/dynamic";
    link.dataset.prefetch = "true";

    document.body.appendChild(link);
    await vi.waitFor(() => {
      expect(prefetchLoader.callbacks.has(link)).toBe(true);
    });

    prefetchLoader.callbacks.get(link)!();
    expect(onPrefetch).toHaveBeenCalledWith(link.href, "queued");

    cleanup();
  });

  it("upgrades a pending viewport prefetch when the pointer enters", () => {
    setDefaultPrefetchStrategy("viewport");
    const link = document.createElement("a");
    link.href = "/target";
    link.dataset.prefetch = "true";
    document.body.appendChild(link);
    const cancelPending = vi.fn();
    const onPrefetch = vi
      .fn<DelegatedPrefetchCallback>()
      .mockReturnValueOnce(cancelPending)
      .mockReturnValueOnce(undefined);
    const cleanup = setupPrefetch(onPrefetch);

    prefetchLoader.callbacks.get(link)!();
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
    link.dataset.prefetch = "true";
    document.body.appendChild(link);
    const cleanup = setupPrefetch(vi.fn<DelegatedPrefetchCallback>());

    expect(prefetchLoader.observeForPrefetch).toHaveBeenCalledTimes(1);
    prefetchLoader.callbacks.get(link)!();

    location = new URL("/another-page", location);
    stateListeners.forEach((listener) => listener());

    expect(prefetchLoader.observeForPrefetch).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("switches adaptive anchors from hover to viewport", () => {
    let hoverNone = false;
    let notifyChange: (() => void) | undefined;
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
    link.dataset.prefetch = "true";
    document.body.appendChild(link);
    const cleanup = setupPrefetch(vi.fn<DelegatedPrefetchCallback>());

    expect(prefetchLoader.observeForPrefetch).not.toHaveBeenCalled();

    hoverNone = true;
    notifyChange!();
    expect(prefetchLoader.observeForPrefetch).toHaveBeenCalledWith(
      link,
      expect.any(Function),
    );
    cleanup();
  });
});
