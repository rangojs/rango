import { isOtherAppPath, type AppBounds } from "../app-bounds.js";

/**
 * The paths of this origin the app owns (src/app-bounds.ts), set once from
 * the initial payload. A document value: a navigation into another app is a
 * document load, which boots that app with its own bounds.
 */
let bounds: AppBounds | undefined;

export function setAppBounds(next: AppBounds | undefined): void {
  bounds = next;
}

/**
 * Whether `href` is a same-origin path another app under the same host router
 * serves. Such a link is a document navigation by nature: Link and the link
 * interceptor leave the click to the browser, prefetch skips it, and a
 * navigation to it loads the document without asking the server first (which
 * would only answer X-RSC-Reload). False without bounds, so an app that owns
 * every path pays one null check, and false for an href that does not parse,
 * which the caller handles as it did before (a click handler must not throw).
 */
export function isOtherAppHref(href: string): boolean {
  if (!bounds) return false;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return false;
  }
  return (
    url.origin === window.location.origin &&
    isOtherAppPath(bounds, url.pathname)
  );
}
