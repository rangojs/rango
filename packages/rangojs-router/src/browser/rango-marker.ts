import { PACKAGE_VERSION } from "@rangojs/router:version";

/**
 * Publishes `window.__rango = { version }` so outside tools can tell a page is
 * a Rango app and which router release serves it. Write-only and informational:
 * nothing in the router reads it (rango-marker.test.ts greps src/ for reads),
 * and only the npm semver is exposed, no build hash, router id or config.
 */
export function publishRangoMarker(): void {
  (window as { __rango?: unknown }).__rango = Object.freeze({
    version: PACKAGE_VERSION,
  });
}
