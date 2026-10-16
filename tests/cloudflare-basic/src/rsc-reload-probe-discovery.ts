// Test-only seam for e2e/dev-rsc-reload.test.ts (#1186): empty except under
// RANGO_E2E_RSC_RELOAD_PROBE=discovery in dev, where rscReloadProbe()
// (vite.config.ts) replaces it. Only the async include of /__client-urls-lazy
// (urls.tsx) imports it, so it first loads during route discovery, before
// src/client-urls/lazy.tsx.
export {};
