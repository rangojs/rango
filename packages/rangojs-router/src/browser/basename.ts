/**
 * Basename storage for href() and Link auto-prefixing.
 *
 * Browser: set once during initBrowserApp() from the RSC payload metadata.
 * SSR: set per-render in SsrRoot from the deserialized payload.
 * RSC: set per-request in the handler before middleware/rendering.
 *
 * Each Vite environment (rsc, ssr, client) has its own module instance,
 * so setBasename() in one environment does not affect the others.
 */

let _basename: string | undefined;

export function setBasename(value: string | undefined): void {
  _basename = value;
}

export function getBasename(): string | undefined {
  return _basename;
}
