// Turns on the suspense audit (suspense-audit.ts) in a dev build. Only this
// repo sets INTERNAL_RANGO_SUSPENSE_AUDIT: the e2e webServers and fixtures of
// the router test-app and cloudflare-basic, and the router's vitest config.
// A consumer's dev server and tests never print the audit's errors.
//
// Runtime fallback for non-Vite contexts (vitest, Node). In the Vite pipeline
// the discovery plugin replaces this module with the build-time-resolved flag
// (vite/inject-client-debug.ts), as it does for internal-debug.ts. Keep this
// module to the single export: the transform replaces the whole file.
export const INTERNAL_RANGO_SUSPENSE_AUDIT: boolean =
  typeof process !== "undefined" &&
  Boolean((process as any).env?.INTERNAL_RANGO_SUSPENSE_AUDIT);
