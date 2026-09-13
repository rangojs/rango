import { createLoader, notFound, redirect } from "@rangojs/router";

// workerd mirror of the test-app fixture (packages/rangojs-router/e2e/test-app/
// src/urls/client-urls-ssr-redirect*): `{ ssr: false }` loaders that settle
// with a redirect()/notFound() signal before the document flush.
export const SsrRedirectLayoutLoader = createLoader(async () => {
  throw redirect("/__client-urls?from=ssr-redirect-layout");
});

export const SsrRedirectPageLoader = createLoader(async () => {
  throw redirect("/__client-urls?from=ssr-redirect-page");
});

export const SsrRedirectChildLoader = createLoader(async () => {
  throw redirect("/__client-urls?from=ssr-redirect-child");
});

export const SsrNotFoundPageLoader = createLoader(async () => {
  notFound("ssr:false not found");
});
