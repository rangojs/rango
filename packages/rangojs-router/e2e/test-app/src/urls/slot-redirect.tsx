import { urls, redirect, Prerender, type Handler } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
// Type-only (erased — no runtime cycle with router.tsx).
import type { AppEnv } from "../router.js";

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

// An on-demand page whose layout slot redirects while `onDemandRedirects` is
// set. A refresh that redirects stores nothing: the page stored before keeps
// serving, stamp included, until a later refresh with no redirect replaces it.
let onDemandRedirects = false;

function OnDemandLayout() {
  return (
    <main data-testid="sr-od-layout">
      <Outlet />
      <ParallelOutlet name="@sr-od-aside" />
    </main>
  );
}

function OnDemandAside() {
  return <aside data-testid="sr-od-aside">aside</aside>;
}

const OnDemandPage = Prerender(
  () => {
    // Captured once per render: a serve that replayed the stored page shows
    // the same stamp, one that replaced it a new one.
    const stamp = `${new Date().toISOString()}-${Math.random().toString(36).slice(2)}`;
    return (
      <div data-testid="sr-od-page">
        <p data-testid="sr-od-stamp">{stamp}</p>
      </div>
    );
  },
  { onDemand: true },
);

const onDemandPatterns = urls(({ path, layout, parallel }) => [
  layout(OnDemandLayout, () => [
    parallel({
      "@sr-od-aside": () =>
        onDemandRedirects ? (
          redirect("/slot-redirect/target", 302)
        ) : (
          <OnDemandAside />
        ),
    }),
    path("/", OnDemandPage, { name: "index" }),
  ]),
]);

/**
 * Toggles the slot's redirect (`?redirect=1` / `?redirect=0`) and otherwise
 * runs the on-demand refresh, as JSON.
 */
const OnDemandTrigger: Handler = async (ctx) => {
  const { router } = await import("../router.js");
  const flag = ctx.searchParams.get("redirect");
  if (flag !== null) {
    onDemandRedirects = flag === "1";
    return Response.json({ redirects: onDemandRedirects });
  }
  const result = await router.prerender({ env: ctx.env as AppEnv })(
    "/slot-redirect/on-demand",
  );
  // Error instances don't survive Response.json: a thrown redirect is
  // reported by the status and Location it carries.
  return Response.json(
    result.ok
      ? { ok: true, status: result.status }
      : {
          ok: false,
          status: result.status,
          error:
            result.error instanceof Response
              ? {
                  status: result.error.status,
                  location: result.error.headers.get("Location"),
                }
              : String(result.error),
        },
  );
};

export const slotRedirectPatterns = urls(({ path, include }) => [
  path("/", SlotRedirectIndex, { name: "index" }),
  path("/target", SlotRedirectTarget, { name: "target" }),
  include("/plain", plainPatterns, { name: "plain" }),
  include("/streamed", streamedPatterns, { name: "streamed" }),
  include("/aside", asidePatterns, { name: "aside" }),
  include("/on-demand", onDemandPatterns, { name: "onDemand" }),
  path("/on-demand-trigger", OnDemandTrigger, { name: "onDemandTrigger" }),
]);
