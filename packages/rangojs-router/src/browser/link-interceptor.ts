import type { LinkInterceptorOptions, NavigateOptions } from "./types.js";
import {
  subscribeToLocationChange,
  type EventController,
} from "./event-controller.js";
import {
  getDefaultPrefetchStrategy,
  resolveAdaptiveStrategy,
  subscribeToAdaptiveStrategyChange,
} from "./prefetch/default-strategy.js";
import { observeForPrefetch } from "./prefetch/observer.js";
import type { PrefetchStrategy } from "../router/prefetch-default.js";

const ELIGIBILITY_ATTRIBUTES = {
  href: "href",
  target: "target",
  download: "download",
  noIntercept: "data-no-intercept",
  linkComponent: "data-link-component",
  external: "data-external",
  prefetch: "data-prefetch",
} as const;

const ELIGIBILITY_ATTRIBUTE_FILTER = Object.values(ELIGIBILITY_ATTRIBUTES);
const ANCHOR_SELECTOR = "a";
const ELIGIBLE_ANCHOR_SELECTOR = `a[${ELIGIBILITY_ATTRIBUTES.href}]`;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const PREFETCH_OPT_OUT_VALUES = new Set(["false", "none"]);
const STATIC_RESOURCE_EXTENSION =
  /\.(?:7z|avif|bmp|bz2|cjs|css|csv|docx?|eot|gif|gz|ico|jpe?g|js|json|m4a|map|mjs|mov|mp3|mp4|ogg|ogv|otf|pdf|png|pptx?|rar|svg|tar|tgz|tiff?|ttf|txt|wasm|wav|webm|webp|woff2?|xlsx?|xml|zip)$/i;

function isElementNode(value: unknown): value is Element {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Node).nodeType === 1 &&
    typeof (value as Element).matches === "function"
  );
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Node).nodeType === "number"
  );
}

/**
 * Check if an anchor points to the same page with only a hash change.
 * Used by both Link component and link-interceptor to let the browser
 * handle anchor scrolling natively.
 */
export function isHashOnlyNavigation(anchor: HTMLAnchorElement): boolean {
  return (
    anchor.pathname === window.location.pathname &&
    anchor.search === window.location.search &&
    !!anchor.hash
  );
}

/**
 * Default link interception predicate
 *
 * Returns true if the link should be intercepted for SPA navigation.
 * Filters out:
 * - Cross-origin links
 * - Links with download attribute
 * - Links with target other than _self
 * - Links with data-no-intercept attribute
 *
 * @param link - The anchor element to check
 * @returns true if the link should be intercepted
 */
export function defaultShouldIntercept(link: HTMLAnchorElement): boolean {
  if (!isEligiblePlainAnchor(link)) return false;

  // Don't intercept hash-only navigation (same path, only fragment changes).
  // Let the browser handle anchor scrolling natively.
  return !isHashOnlyNavigation(link);
}

function isEligiblePlainAnchor(link: HTMLAnchorElement): boolean {
  // Namespace identity survives adoptNode/importNode across realms; instanceof
  // does not. Structural test doubles omit namespaceURI and retain the legacy
  // property-based behavior.
  if (link.namespaceURI && link.namespaceURI !== HTML_NAMESPACE) {
    return false;
  }

  // Only handle same-origin links
  if (link.origin !== window.location.origin) {
    return false;
  }

  // Skip links with a download attribute
  if (link.hasAttribute(ELIGIBILITY_ATTRIBUTES.download)) {
    return false;
  }

  // Skip links targeting another browsing context
  const target = link.getAttribute(ELIGIBILITY_ATTRIBUTES.target);
  if (target && target !== "_self") {
    return false;
  }

  // Skip links explicitly excluded from delegated handling
  if (link.getAttribute(ELIGIBILITY_ATTRIBUTES.noIntercept) === "true") {
    return false;
  }

  // Link components handle their own navigation and prefetch
  if (link.hasAttribute(ELIGIBILITY_ATTRIBUTES.linkComponent)) {
    return false;
  }

  // Skip links explicitly marked external
  if (link.hasAttribute(ELIGIBILITY_ATTRIBUTES.external)) {
    return false;
  }

  return true;
}

function normalizePathname(pathname: string): string {
  return pathname
    .replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase())
    .replace(/\/+$/, "");
}

function normalizeBasename(basename?: string): string | undefined {
  if (!basename) return undefined;
  return normalizePathname(new URL(basename, window.location.origin).pathname);
}

function defaultShouldPrefetchInBasename(
  link: HTMLAnchorElement,
  basename?: string,
): boolean {
  if (!isEligiblePlainAnchor(link)) return false;

  const prefetch = link.getAttribute(ELIGIBILITY_ATTRIBUTES.prefetch);
  if (prefetch && PREFETCH_OPT_OUT_VALUES.has(prefetch)) return false;

  const pathname = normalizePathname(link.pathname);
  if (
    basename !== undefined &&
    pathname !== basename &&
    !pathname.startsWith(`${basename}/`)
  ) {
    return false;
  }

  // Scope is decided on canonical encoded path segments. Decode only after
  // that boundary check so encoded separators can never expand router scope.
  let resourcePathname: string;
  try {
    resourcePathname = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (prefetch !== "true" && STATIC_RESOURCE_EXTENSION.test(resourcePathname)) {
    return false;
  }
  return true;
}

/** Plain anchors follow the router default unless explicitly opted out. */
export function defaultShouldPrefetch(
  link: HTMLAnchorElement,
  basename?: string,
): boolean {
  return defaultShouldPrefetchInBasename(link, normalizeBasename(basename));
}

/**
 * Set up link interception for SPA navigation
 *
 * Attaches a global click handler to intercept clicks on anchor elements and
 * call the onNavigate callback instead of performing a full page load.
 *
 * @param onNavigate - Callback when a link should navigate via SPA
 * @param options - Configuration options
 * @returns Cleanup function to remove the event listener
 *
 * @example
 * ```typescript
 * const cleanup = setupLinkInterception((url) => {
 *   window.history.pushState({}, "", url);
 *   fetchPartialUpdate(url);
 * });
 *
 * // Later, to clean up:
 * cleanup();
 * ```
 */
export function setupLinkInterception(
  onNavigate: (url: string, options?: NavigateOptions) => void,
  options?: LinkInterceptorOptions,
): () => void {
  const shouldIntercept = options?.shouldIntercept ?? defaultShouldIntercept;

  const handleClick = (event: MouseEvent) => {
    // If event was already handled by Link component (or other handler), skip
    if (event.defaultPrevented) {
      return;
    }

    if (!isElementNode(event.target)) return;
    const target = event.target;
    const link = target.closest("a");

    if (!link || !shouldIntercept(link)) {
      return;
    }

    // Don't intercept if modifier keys are pressed (open in new tab, etc.)
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    const href = link.href;

    // Read navigation options from data attributes (set by Link component)
    const scrollAttr = link.getAttribute("data-scroll");
    const replaceAttr = link.getAttribute("data-replace");
    const revalidateAttr = link.getAttribute("data-revalidate");

    const navigateOptions: NavigateOptions = {};
    if (scrollAttr === "false") {
      navigateOptions.scroll = false;
    }
    if (replaceAttr === "true") {
      navigateOptions.replace = true;
    }
    if (revalidateAttr === "false") {
      navigateOptions.revalidate = false;
    }

    onNavigate(href, navigateOptions);
  };

  document.addEventListener("click", handleClick);

  return () => {
    document.removeEventListener("click", handleClick);
  };
}

export type DelegatedPrefetchCallback = (
  url: string,
  priority: "direct" | "queued",
) => void | (() => void);

export interface DelegatedPrefetchOptions {
  eventController: Pick<EventController, "getState" | "subscribe">;
  shouldPrefetch?: (link: HTMLAnchorElement) => boolean;
  defaultPrefetch?: PrefetchStrategy;
  root?: HTMLElement;
  basename?: string;
}

interface DelegatedPrefetchState {
  stopObserving?: () => void;
  cancelPending?: () => void;
  locationHref: string;
}

export function setupDelegatedLinkPrefetch(
  onPrefetch: DelegatedPrefetchCallback,
  options: DelegatedPrefetchOptions,
): () => void {
  const defaultStrategy =
    options.defaultPrefetch ?? getDefaultPrefetchStrategy();
  if (defaultStrategy === "none") return () => {};

  const basename = normalizeBasename(options.basename);
  const shouldPrefetch =
    options.shouldPrefetch ??
    ((link: HTMLAnchorElement) =>
      defaultShouldPrefetchInBasename(link, basename));
  const states = new Map<HTMLAnchorElement, DelegatedPrefetchState>();
  let strategy = resolveAdaptiveStrategy(defaultStrategy);

  const currentLocationHref = () =>
    options.eventController.getState().location.href;

  const unregister = (link: HTMLAnchorElement) => {
    const state = states.get(link);
    state?.stopObserving?.();
    state?.cancelPending?.();
    states.delete(link);
    if (strategy === "hover") syncMutationObserver();
  };

  const isEligible = (link: HTMLAnchorElement) =>
    link.hasAttribute(ELIGIBILITY_ATTRIBUTES.href) && shouldPrefetch(link);

  const trigger = (link: HTMLAnchorElement, priority: "direct" | "queued") => {
    if (!isEligible(link)) {
      unregister(link);
      return;
    }

    let state = states.get(link);
    if (!state) {
      state = { locationHref: currentLocationHref() };
      states.set(link, state);
    }
    state.cancelPending?.();
    state.cancelPending = undefined;
    try {
      state.cancelPending = onPrefetch(link.href, priority) ?? undefined;
    } finally {
      if (strategy === "hover" && !state.cancelPending) states.delete(link);
      syncMutationObserver();
    }
  };

  const register = (link: HTMLAnchorElement) => {
    unregister(link);
    if (!isEligible(link)) return;
    if (strategy === "hover") return;

    const state: DelegatedPrefetchState = {
      locationHref: currentLocationHref(),
    };
    states.set(link, state);

    if (strategy === "render") {
      trigger(link, "queued");
    } else if (strategy === "viewport") {
      state.stopObserving = observeForPrefetch(link, () => {
        state.stopObserving = undefined;
        trigger(link, "queued");
      });
    }
  };

  const visitAnchors = (
    node: Node,
    visit: (link: HTMLAnchorElement) => void,
  ) => {
    if (!isElementNode(node)) return;
    if (node.matches(ANCHOR_SELECTOR)) {
      visit(node as HTMLAnchorElement);
    }
    node
      .querySelectorAll<HTMLAnchorElement>(ANCHOR_SELECTOR)
      .forEach((link) => visit(link));
  };

  const root = options.root ?? document.documentElement;
  let mutationObserver: MutationObserver | undefined;
  function syncMutationObserver(): void {
    const shouldObserve =
      strategy === "viewport" || strategy === "render" || states.size > 0;
    if (!shouldObserve) {
      mutationObserver?.disconnect();
      mutationObserver = undefined;
      return;
    }
    if (mutationObserver || typeof MutationObserver === "undefined" || !root) {
      return;
    }

    mutationObserver = new MutationObserver((mutations) => {
      const affected = new Set<HTMLAnchorElement>();
      const markAffected = (link: HTMLAnchorElement) => affected.add(link);
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          if (
            isElementNode(mutation.target) &&
            mutation.target.matches(ANCHOR_SELECTOR)
          ) {
            affected.add(mutation.target as HTMLAnchorElement);
          }
          continue;
        }
        mutation.removedNodes.forEach((node) =>
          visitAnchors(node, markAffected),
        );
        mutation.addedNodes.forEach((node) => visitAnchors(node, markAffected));
      }
      for (const link of affected) {
        if (link.isConnected && root.contains(link)) register(link);
        else unregister(link);
      }
    });
    mutationObserver.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ELIGIBILITY_ATTRIBUTE_FILTER,
    });
  }

  const rescan = () => {
    for (const link of [...states.keys()]) unregister(link);
    strategy = resolveAdaptiveStrategy(defaultStrategy);
    syncMutationObserver();
    if ((strategy === "viewport" || strategy === "render") && root) {
      visitAnchors(root, register);
    }
  };

  rescan();

  const handleMouseOver = (event: MouseEvent) => {
    if (!isElementNode(event.target)) return;

    const link = event.target.closest<HTMLAnchorElement>(
      ELIGIBLE_ANCHOR_SELECTOR,
    );
    if (!link || !root.contains(link)) return;
    if (isNode(event.relatedTarget) && link.contains(event.relatedTarget)) {
      return;
    }
    trigger(link, "direct");
  };

  if (strategy === "hover" || strategy === "viewport") {
    root.addEventListener("mouseover", handleMouseOver);
  }

  const unsubscribeLocation =
    defaultStrategy === "viewport" ||
    defaultStrategy === "render" ||
    defaultStrategy === "adaptive"
      ? subscribeToLocationChange(options.eventController, (nextHref) => {
          if (strategy !== "viewport" && strategy !== "render") return;
          for (const [link, state] of [...states]) {
            if (state.locationHref === nextHref) continue;
            if (link.isConnected && root.contains(link)) register(link);
            else unregister(link);
          }
        })
      : undefined;
  const unsubscribeAdaptive =
    defaultStrategy === "adaptive"
      ? subscribeToAdaptiveStrategyChange(rescan)
      : undefined;

  return () => {
    mutationObserver?.disconnect();
    root.removeEventListener("mouseover", handleMouseOver);
    unsubscribeLocation?.();
    unsubscribeAdaptive?.();
    for (const link of [...states.keys()]) unregister(link);
  };
}
