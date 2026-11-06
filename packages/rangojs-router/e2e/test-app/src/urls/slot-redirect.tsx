import { urls, redirect } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";

// A parallel slot handler's redirect().
//
// A slot handler's result passes through handleHandlerResult, as a route's or a
// layout's does, so a returned redirect() short-circuits to a real HTTP
// redirect instead of being rendered as the slot's component. A synchronous
// return under the slot's own loading() short-circuits too.
//
// Each slot sits under its own mount so the three pages have their own layout
// entry, as they would in an app: /plain redirects, /streamed redirects under
// the slot's loading(), /aside renders.
function SlotLayout() {
  return (
    <main data-testid="sr-layout">
      <Outlet />
      <ParallelOutlet name="@sr-aside" />
    </main>
  );
}

function SlotAside() {
  return <aside data-testid="sr-aside">aside</aside>;
}

function SlotRedirectPage() {
  return <div data-testid="sr-page">page that never renders</div>;
}

function SlotAsidePage() {
  return <div data-testid="sr-ok">ok page</div>;
}

function SlotRedirectTarget() {
  return <div data-testid="sr-target">arrived</div>;
}

function SlotRedirectIndex() {
  return (
    <div data-testid="sr-index">
      <Link to="/slot-redirect/plain" data-testid="sr-link-plain">
        go plain
      </Link>
      <Link to="/slot-redirect/streamed" data-testid="sr-link-streamed">
        go streamed
      </Link>
      <Link to="/slot-redirect/aside" data-testid="sr-link-aside">
        go aside
      </Link>
    </div>
  );
}

/** A synchronous returned redirect() from a slot handler. */
const plainPatterns = urls(({ path, layout, parallel }) => [
  layout(SlotLayout, () => [
    parallel({ "@sr-aside": () => redirect("/slot-redirect/target", 302) }),
    path("/", SlotRedirectPage, { name: "index" }),
  ]),
]);

/** The same return under the slot's own loading(). */
const streamedPatterns = urls(({ path, layout, parallel, loading }) => [
  layout(SlotLayout, () => [
    parallel({
      "@sr-aside": {
        handler: () => redirect("/slot-redirect/target", 302),
        use: () => [loading(<div data-testid="sr-skeleton">Loading...</div>)],
      },
    }),
    path("/", SlotRedirectPage, { name: "index" }),
  ]),
]);

/** A slot that renders: a normal page still works beside the two above. */
const asidePatterns = urls(({ path, layout, parallel }) => [
  layout(SlotLayout, () => [
    parallel({ "@sr-aside": SlotAside }),
    path("/", SlotAsidePage, { name: "index" }),
  ]),
]);

export const slotRedirectPatterns = urls(({ path, include }) => [
  path("/", SlotRedirectIndex, { name: "index" }),
  path("/target", SlotRedirectTarget, { name: "target" }),
  include("/plain", plainPatterns, { name: "plain" }),
  include("/streamed", streamedPatterns, { name: "streamed" }),
  include("/aside", asidePatterns, { name: "aside" }),
]);
