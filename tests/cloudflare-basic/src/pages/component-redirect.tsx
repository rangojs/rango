import { redirect, urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

// Fixture: a `redirect()` thrown from a SERVER COMPONENT rather than from a
// handler or a loader. React's Flight renderer catches it and reports it
// through `onError`, so the router carries the target in the error row's
// digest (src/render-redirect.ts) and the visitor ends on the target on both
// lanes: a document load of /component-redirect/gated, and a click on the
// link below.
async function GatedGate(): Promise<React.ReactNode> {
  // An await before the throw, as a session lookup has: the render suspends
  // first, so the redirect is decided after the page started rendering.
  await new Promise((resolve) => setTimeout(resolve, 10));
  throw redirect("/component-redirect/target");
}

function GatedPage(): React.ReactNode {
  return (
    <main data-testid="component-redirect-gated">
      <h1>Gated</h1>
      <GatedGate />
    </main>
  );
}

function ComponentRedirectIndex(): React.ReactNode {
  return (
    <main data-testid="component-redirect-index">
      <Link
        to="/component-redirect/gated"
        data-testid="component-redirect-link"
      >
        gated
      </Link>
    </main>
  );
}

/**
 * The same gate under a route that declares `loading()`: the throw lands
 * inside the streamed Suspense boundary, so the document is a 200 and the
 * browser makes the replace after hydration.
 */
async function LoadingGate(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  throw redirect("/component-redirect/target");
}

function LoadingPage(): React.ReactNode {
  return (
    <main data-testid="component-redirect-loading">
      <h1>Gated</h1>
      <LoadingGate />
    </main>
  );
}

function ComponentRedirectTarget(): React.ReactNode {
  return <main data-testid="component-redirect-target">signed in</main>;
}

export const componentRedirectPatterns = urls(({ path, loading }) => [
  path("/component-redirect", ComponentRedirectIndex, {
    name: "componentRedirect",
  }),
  path("/component-redirect/gated", GatedPage, {
    name: "componentRedirectGated",
  }),
  path(
    "/component-redirect/loading",
    LoadingPage,
    { name: "componentRedirectLoading" },
    () => [loading(<p data-testid="component-redirect-fallback">checking</p>)],
  ),
  path("/component-redirect/target", ComponentRedirectTarget, {
    name: "componentRedirectTarget",
  }),
]);
