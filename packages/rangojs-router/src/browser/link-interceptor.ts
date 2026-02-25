import type { LinkInterceptorOptions, NavigateOptions } from "./types.js";

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
  // Only intercept same-origin links
  if (link.origin !== window.location.origin) {
    return false;
  }

  // Don't intercept if it has download attribute
  if (link.hasAttribute("download")) {
    return false;
  }

  // Don't intercept if target is set to something other than _self
  if (link.target && link.target !== "_self") {
    return false;
  }

  // Don't intercept if explicitly disabled
  if (link.getAttribute("data-no-intercept") === "true") {
    return false;
  }

  // Don't intercept Link component anchors - they handle their own navigation
  if (link.hasAttribute("data-link-component")) {
    return false;
  }

  // Don't intercept external links
  if (link.hasAttribute("data-external")) {
    return false;
  }

  return true;
}

/**
 * Set up link interception for SPA navigation
 *
 * Attaches a global click handler to intercept clicks on anchor elements
 * and call the onNavigate callback instead of performing a full page load.
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

    const target = event.target as HTMLElement;
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

    const navigateOptions: NavigateOptions = {};
    if (scrollAttr === "false") {
      navigateOptions.scroll = false;
    }
    if (replaceAttr === "true") {
      navigateOptions.replace = true;
    }

    onNavigate(href, navigateOptions);
  };

  document.addEventListener("click", handleClick);

  console.log("[Browser] Link interception enabled");

  return () => {
    document.removeEventListener("click", handleClick);
    console.log("[Browser] Link interception disabled");
  };
}
