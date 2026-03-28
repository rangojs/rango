/**
 * Basename storage for href() and Link auto-prefixing.
 *
 * In the browser: set once during initBrowserApp() from the RSC payload.
 * During SSR: set per-request by the RSC handler before rendering client
 * components, so href() produces the same output as in the browser.
 */

let _basename: string | undefined;

export function setBasename(value: string | undefined): void {
  _basename = value;
}

export function getBasename(): string | undefined {
  return _basename;
}
