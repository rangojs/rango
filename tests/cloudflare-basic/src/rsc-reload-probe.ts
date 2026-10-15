// Test-only seam for e2e/dev-rsc-reload.test.ts (#1186): empty except under
// RANGO_E2E_RSC_RELOAD_PROBE=1 in dev, where rscReloadProbe() (vite.config.ts)
// replaces it. urls.tsx imports it between @rangojs/router and the groups.
export {};
