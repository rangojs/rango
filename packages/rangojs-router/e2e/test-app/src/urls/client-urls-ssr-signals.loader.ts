import { createLoader, notFound, redirect } from "@rangojs/router";

// Repro: a { ssr: false } loader that redirects, read by a client LAYOUT
// (above any route Suspense) and by a PAGE (inside RouteContentWrapper).
export const SsrRedirectLayoutLoader = createLoader(async () => {
  throw redirect("/client-urls-e2e/state?from=ssr-redirect-layout");
});

export const SsrRedirectPageLoader = createLoader(async () => {
  throw redirect("/client-urls-e2e/state?from=ssr-redirect-page");
});

export const SsrRedirectChildLoader = createLoader(async () => {
  throw redirect("/client-urls-e2e/state?from=ssr-redirect-child");
});

export const SsrNotFoundPageLoader = createLoader(async () => {
  notFound("ssr:false not found");
});
