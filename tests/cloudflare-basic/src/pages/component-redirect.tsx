import { redirect, urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import type { ReactNode } from "react";

/**
 * A component (not a handler) that throws redirect() while React renders it
 * (e2e/component-redirect.test.ts). The render answers it as a handler's throw
 * is answered, while its status is still open: a document request with the
 * redirect's 3xx, a client navigation with 204 + X-RSC-Redirect. A redirect an
 * async component throws is reported after a Flight response's opening flush,
 * so a client navigation renders the boundary instead — the documented limit
 * (docs/internal/execution-model.md).
 */

const TARGET = "/component-redirect/target";

function SyncRedirect(): ReactNode {
  throw redirect(TARGET);
}

async function AsyncRedirect(): Promise<ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  throw redirect(TARGET);
}

function Index(): ReactNode {
  return (
    <main data-testid="component-redirect-index">
      <Link to="/component-redirect/sync" prefetch="none" data-testid="to-sync">
        sync redirect
      </Link>
      <Link
        to="/component-redirect/async"
        prefetch="none"
        data-testid="to-async"
      >
        async redirect
      </Link>
    </main>
  );
}

export const componentRedirectPatterns = urls(({ path, errorBoundary }) => [
  path("/component-redirect", () => <Index />, {
    name: "componentRedirect",
  }),
  path(
    "/component-redirect/target",
    () => <main data-testid="component-redirect-target">target page</main>,
    { name: "componentRedirectTarget" },
  ),
  path("/component-redirect/sync", () => <SyncRedirect />, {
    name: "componentRedirectSync",
  }),
  path("/component-redirect/async", () => <AsyncRedirect />, {
    name: "componentRedirectAsync",
  }),
  // A declared boundary is no place for control flow: the redirect still
  // answers the response, the fallback never renders.
  path(
    "/component-redirect/bounded",
    () => <SyncRedirect />,
    { name: "componentRedirectBounded" },
    () => [
      errorBoundary(({ error }) => (
        <p data-testid="component-redirect-boundary">{error.message}</p>
      )),
    ],
  ),
]);
