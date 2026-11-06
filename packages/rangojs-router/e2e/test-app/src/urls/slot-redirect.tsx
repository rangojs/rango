import { urls, redirect } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";

// A parallel slot handler's redirect().
//
// A slot handler's result now passes through handleHandlerResult, as a route's
// or a layout's does, so a returned redirect() short-circuits to a real HTTP
// redirect instead of being rendered as the slot's component. A synchronous
// return under the slot's own loading() short-circuits too.
//
// Each slot gets its own layout under its own mount: two sibling layouts at
// one position share a segment id, and the browser could not tell them apart.
function PlainSlotLayout() {
  return (
    <main data-testid="sr-plain-layout">
      <Outlet />
      <ParallelOutlet name="@sr-aside" />
    </main>
  );
}

function StreamedSlotLayout() {
  return (
    <main data-testid="sr-streamed-layout">
      <Outlet />
      <ParallelOutlet name="@sr-aside" />
    </main>
  );
}

function AsideSlotLayout() {
  return (
    <main data-testid="sr-aside-layout">
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

function SlotRedirectAsidePage() {
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
  layout(PlainSlotLayout, () => [
    parallel({ "@sr-aside": () => redirect("/slot-redirect/target", 302) }),
    path("/", SlotRedirectPage, { name: "index" }),
  ]),
]);

/** The same return under the slot's own loading(). */
const streamedPatterns = urls(({ path, layout, parallel, loading }) => [
  layout(StreamedSlotLayout, () => [
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
  layout(AsideSlotLayout, () => [
    parallel({ "@sr-aside": SlotAside }),
    path("/", SlotRedirectAsidePage, { name: "index" }),
  ]),
]);

export const slotRedirectPatterns = urls(({ path, include }) => [
  path("/", SlotRedirectIndex, { name: "index" }),
  path("/target", SlotRedirectTarget, { name: "target" }),
  include("/plain", plainPatterns, { name: "plain" }),
  include("/streamed", streamedPatterns, { name: "streamed" }),
  include("/aside", asidePatterns, { name: "aside" }),
]);
