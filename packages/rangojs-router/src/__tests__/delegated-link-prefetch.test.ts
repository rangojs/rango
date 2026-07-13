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
  defaultShouldIntercept,
  setupDelegatedLinkPrefetch,
  setupLinkInterception,
} from "../browser/link-interceptor.js";
import { setDefaultPrefetchStrategy } from "../browser/prefetch/default-strategy.js";

let location: URL;
let stateListeners: Set<() => void>;

function setupPrefetch(
  onPrefetch: DelegatedPrefetchCallback,
  defaultPrefetch?: "hover" | "none" | "viewport",
  basename?: string,
  shouldPrefetch?: (link: HTMLAnchorElement) => boolean,
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
    shouldPrefetch,
  });
}

describe("delegated plain-anchor prefetch", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/");
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
      <a href="/other-effect" data-prefetch="none">strategy-style opt-out</a>
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
      <a href="/app%2Fadmin" data-testid="encoded-separator">encoded separator</a>
      <a href="/app/blog/intro.js" data-prefetch="true" data-testid="forced-route">forced route</a>
      <a href="/app/report.data" data-testid="route">suffix route</a>
    `;
    const forcedRoute = document.querySelector<HTMLAnchorElement>(
      '[data-testid="forced-route"]',
    )!;
    const route = document.querySelector<HTMLAnchorElement>(
      '[data-testid="route"]',
    )!;

    const cleanup = setupPrefetch(vi.fn(), "viewport", "/app");

    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledTimes(2);
    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
      route,
      expect.any(Function),
    );
    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
      forcedRoute,
      expect.any(Function),
    );
    cleanup();
  });

  it("allows explicit opt-in when only resource decoding is malformed", () => {
    const link = document.createElement("a");
    link.href = "/app/promo/50%off";
    link.dataset.prefetch = "true";
    document.body.appendChild(link);

    const cleanup = setupPrefetch(vi.fn(), "viewport", "/app");

    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
      link,
      expect.any(Function),
    );
    cleanup();
  });

  it("skips same-page hash anchors before observer registration", () => {
    const hashOnly = document.createElement("a");
    hashOnly.href = `${window.location.pathname}${window.location.search}#section`;
    const otherPage = document.createElement("a");
    otherPage.href = "/other#section";
    document.body.append(hashOnly, otherPage);

    const cleanup = setupPrefetch(vi.fn(), "viewport");

    expect(prefetchObserver.observeForPrefetch).not.toHaveBeenCalledWith(
      hashOnly,
      expect.any(Function),
    );
    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
      otherPage,
      expect.any(Function),
    );
    cleanup();
  });

  it("re-evaluates a parked hash-only anchor after location changes", () => {
    window.history.replaceState({}, "", "/docs");
    location = new URL(window.location.href);
    const link = document.createElement("a");
    link.href = "/docs#install";
    document.body.appendChild(link);
    const cleanup = setupPrefetch(vi.fn(), "viewport");

    expect(prefetchObserver.observeForPrefetch).not.toHaveBeenCalled();

    window.history.replaceState({}, "", "/other");
    location = new URL(window.location.href);
    stateListeners.forEach((listener) => listener());

    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
      link,
      expect.any(Function),
    );
    cleanup();
  });

  it("does not park permanent eligibility failures", () => {
    const link = document.createElement("a");
    link.href = "/report.pdf";
    const pathname = vi.fn(() => "/report.pdf");
    Object.defineProperty(link, "pathname", { get: pathname });
    document.body.appendChild(link);
    const cleanup = setupPrefetch(vi.fn(), "viewport");
    expect(pathname).toHaveBeenCalledOnce();

    window.history.replaceState({}, "", "/other");
    location = new URL(window.location.href);
    stateListeners.forEach((listener) => listener());

    expect(pathname).toHaveBeenCalledOnce();
    cleanup();
  });

  it.each(["/café", "/caf%C3%A9", "/caf%c3%a9"])(
    "matches a canonical encoded pathname against basename %s",
    (basename) => {
      const link = document.createElement("a");
      link.href = "/caf%C3%A9/menu";
      document.body.appendChild(link);

      const cleanup = setupPrefetch(vi.fn(), "viewport", basename);

      expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
        link,
        expect.any(Function),
      );
      cleanup();
    },
  );

  it("ignores inline SVG anchors without reading HTMLAnchorElement fields", () => {
    document.body.innerHTML = `
      <svg><a href="/dashboard" data-testid="svg-link"><path /></a></svg>
      <a href="/dashboard" data-testid="html-link">dashboard</a>
    `;
    const htmlLink = document.querySelector<HTMLAnchorElement>(
      '[data-testid="html-link"]',
    )!;
    let cleanup!: () => void;

    expect(() => {
      cleanup = setupPrefetch(vi.fn(), "viewport");
    }).not.toThrow();
    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledOnce();
    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
      htmlLink,
      expect.any(Function),
    );
    cleanup();
  });

  it("accepts HTML anchors from another realm without instanceof identity", () => {
    const url = new URL("/dashboard", window.location.href);
    const foreignLink = {
      namespaceURI: "http://www.w3.org/1999/xhtml",
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      hasAttribute: () => false,
      getAttribute: () => null,
    } as unknown as HTMLAnchorElement;

    expect(foreignLink).not.toBeInstanceOf(HTMLAnchorElement);
    expect(defaultShouldIntercept(foreignLink)).toBe(true);
  });

  it("registers and hovers an adopted cross-realm anchor", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const foreignLink = iframe.contentDocument!.createElement("a");
    const adoptedLink = document.adoptNode(foreignLink);
    iframe.remove();
    adoptedLink.href = "/dashboard";
    const viewportCleanup = setupPrefetch(vi.fn(), "viewport");

    document.body.appendChild(adoptedLink);
    await vi.waitFor(() =>
      expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
        adoptedLink,
        expect.any(Function),
      ),
    );
    viewportCleanup();

    const onPrefetch = vi.fn<DelegatedPrefetchCallback>();
    const hoverCleanup = setupPrefetch(onPrefetch, "hover");
    adoptedLink.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(onPrefetch).toHaveBeenCalledWith(adoptedLink.href, "direct");
    hoverCleanup();
  });

  it("rejects ineligible and opted-out anchors before reading pathname", () => {
    const external = document.createElement("a");
    external.href = "https://example.com/target";
    const externalPathname = vi.fn(() => {
      throw new Error("external pathname read");
    });
    Object.defineProperty(external, "pathname", { get: externalPathname });

    const optedOut = document.createElement("a");
    optedOut.href = "/logout";
    optedOut.dataset.prefetch = "none";
    const optedOutPathname = vi.fn(() => {
      throw new Error("opted-out pathname read");
    });
    Object.defineProperty(optedOut, "pathname", { get: optedOutPathname });
    document.body.append(external, optedOut);

    const cleanup = setupPrefetch(vi.fn(), "viewport");

    expect(prefetchObserver.observeForPrefetch).not.toHaveBeenCalled();
    expect(externalPathname).not.toHaveBeenCalled();
    expect(optedOutPathname).not.toHaveBeenCalled();
    cleanup();
  });

  it("treats a container prefetch scope as a hard opt-out", () => {
    const section = document.createElement("section");
    section.dataset.prefetchScope = "none";
    const link = document.createElement("a");
    link.href = "/reports/2026.csv";
    link.dataset.prefetch = "true";
    const pathname = vi.fn(() => "/reports/2026.csv");
    Object.defineProperty(link, "pathname", { get: pathname });
    section.appendChild(link);
    document.body.appendChild(section);

    const cleanup = setupPrefetch(vi.fn(), "viewport");

    expect(prefetchObserver.observeForPrefetch).not.toHaveBeenCalled();
    expect(pathname).not.toHaveBeenCalled();
    cleanup();
  });

  it("does not let a custom predicate override a container scope", () => {
    const section = document.createElement("section");
    section.dataset.prefetchScope = "none";
    const link = document.createElement("a");
    link.href = "/scoped";
    section.appendChild(link);
    document.body.appendChild(section);
    const shouldPrefetch = vi.fn(() => true);

    const cleanup = setupPrefetch(
      vi.fn(),
      "viewport",
      undefined,
      shouldPrefetch,
    );

    expect(shouldPrefetch).not.toHaveBeenCalled();
    expect(prefetchObserver.observeForPrefetch).not.toHaveBeenCalled();
    cleanup();
  });

  it("does not park a permanent custom-predicate rejection", () => {
    const link = document.createElement("a");
    link.href = "/custom-reject";
    document.body.appendChild(link);
    const shouldPrefetch = vi.fn(() => false);
    const cleanup = setupPrefetch(
      vi.fn(),
      "viewport",
      undefined,
      shouldPrefetch,
    );
    expect(shouldPrefetch).toHaveBeenCalledOnce();

    window.history.replaceState({}, "", "/other");
    location = new URL(window.location.href);
    stateListeners.forEach((listener) => listener());

    expect(shouldPrefetch).toHaveBeenCalledOnce();
    cleanup();
  });

  it("accepts false as a container scope opt-out", () => {
    const section = document.createElement("section");
    section.dataset.prefetchScope = "false";
    const link = document.createElement("a");
    link.href = "/scoped";
    link.dataset.prefetch = "true";
    section.appendChild(link);
    document.body.appendChild(section);

    const cleanup = setupPrefetch(vi.fn(), "viewport");

    expect(prefetchObserver.observeForPrefetch).not.toHaveBeenCalled();
    cleanup();
  });

  it("reads one pathname for encoded scope and resource checks", () => {
    const link = document.createElement("a");
    link.href = "/caf%C3%A9/report.data";
    const pathname = vi.fn(() => "/caf%C3%A9/report.data");
    Object.defineProperty(link, "pathname", { get: pathname });
    document.body.appendChild(link);

    const cleanup = setupPrefetch(vi.fn(), "viewport", "/café");

    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
      link,
      expect.any(Function),
    );
    expect(pathname).toHaveBeenCalledOnce();
    cleanup();
  });

  it("re-evaluates a static-looking anchor when it explicitly opts in", async () => {
    const link = document.createElement("a");
    link.href = "/report.csv";
    document.body.appendChild(link);
    const cleanup = setupPrefetch(vi.fn(), "viewport");
    expect(prefetchObserver.observeForPrefetch).not.toHaveBeenCalled();

    link.dataset.prefetch = "true";

    await vi.waitFor(() =>
      expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledWith(
        link,
        expect.any(Function),
      ),
    );
    cleanup();
  });

  it("re-evaluates only anchors in a changed container scope", async () => {
    const section = document.createElement("section");
    const scopedLink = document.createElement("a");
    scopedLink.href = "/scoped";
    section.appendChild(scopedLink);
    const outsideLink = document.createElement("a");
    outsideLink.href = "/outside";
    document.body.append(section, outsideLink);
    const cleanup = setupPrefetch(vi.fn(), "viewport");

    expect(prefetchObserver.callbacks.has(scopedLink)).toBe(true);
    expect(prefetchObserver.callbacks.has(outsideLink)).toBe(true);

    section.dataset.prefetchScope = "none";
    await vi.waitFor(() => {
      expect(prefetchObserver.callbacks.has(scopedLink)).toBe(false);
    });
    expect(prefetchObserver.callbacks.has(outsideLink)).toBe(true);
    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledTimes(2);

    section.removeAttribute("data-prefetch-scope");
    await vi.waitFor(() => {
      expect(prefetchObserver.callbacks.has(scopedLink)).toBe(true);
    });
    expect(prefetchObserver.observeForPrefetch).toHaveBeenCalledTimes(3);
    cleanup();
  });

  it("honors explicit opt-in and opt-out values on direct hover", () => {
    const optedIn = document.createElement("a");
    optedIn.href = "/report.csv";
    optedIn.dataset.prefetch = "true";
    const optedOut = document.createElement("a");
    optedOut.href = "/logout";
    optedOut.dataset.prefetch = "none";
    document.body.append(optedIn, optedOut);
    const onPrefetch = vi.fn<DelegatedPrefetchCallback>();
    const cleanup = setupPrefetch(onPrefetch, "hover");

    optedOut.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(onPrefetch).not.toHaveBeenCalled();
    optedIn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(onPrefetch).toHaveBeenCalledWith(optedIn.href, "direct");
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

  it("re-observes persistent anchors after SPA navigation", () => {
    setDefaultPrefetchStrategy("viewport");
    const link = document.createElement("a");
    link.href = "/persistent-target";
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
    link.href = "/persistent-target";
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
