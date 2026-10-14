import { urls, type HandlerContext } from "@rangojs/router";
import { Html, Link, Outlet } from "@rangojs/router/client";

// Cloudflare-basic mirror of the router e2e app's /vt-back/* fixture
// (urls/vt-back.tsx). A back/forward restored from the history cache runs a
// view transition under transition() (e2e vt-back.test.ts, scenario in
// tests/shared-e2e/src/vt-back-scenario.ts). Tall pages, so each entry has
// a scroll position to restore; the links sit in a fixed header, so a click
// does not scroll. /vt-back/* has transition(), /vt-back-plain/* does not.

const ROWS = Array.from({ length: 60 }, (_, i) => i + 1);

function VtBackPage({ base, label }: { base: string; label: string }) {
  return (
    <div data-testid="vtb-shell">
      <nav
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          zIndex: 10,
          background: "white",
        }}
      >
        <Link to={`${base}/list`} prefetch="none" data-testid="vtb-to-list">
          list
        </Link>{" "}
        <Link
          to={`${base}/detail/1`}
          prefetch="none"
          data-testid="vtb-to-detail-1"
        >
          detail 1
        </Link>{" "}
        <Link
          to={`${base}/detail/2`}
          prefetch="none"
          data-testid="vtb-to-detail-2"
        >
          detail 2
        </Link>{" "}
        <Link
          to="/vt-back/detail/2"
          prefetch="none"
          data-testid="vtb-to-animated"
        >
          animated detail 2
        </Link>
      </nav>
      <h1 data-testid="vtb-page">{label}</h1>
      <ol>
        {ROWS.map((row) => (
          <li key={row} style={{ height: 120 }}>
            {`${label} row ${row}`}
          </li>
        ))}
      </ol>
    </div>
  );
}

function List(ctx: HandlerContext) {
  return <VtBackPage base={vtBackBase(ctx)} label="list" />;
}

function Detail(ctx: HandlerContext<{ id: string }>) {
  return (
    <VtBackPage base={vtBackBase(ctx)} label={`detail ${ctx.params.id}`} />
  );
}

function vtBackBase(ctx: { url: URL }): string {
  return `/${ctx.url.pathname.split("/")[1]}`;
}

// This app's document renders no <Html.ScrollRestoration>, so the browser
// restores scroll ("auto") and a back/forward commits inside its event (the
// router e2e app's default document renders one). The fixture's pages bring
// their own.
function VtBackLayout() {
  return (
    <>
      <Html.ScrollRestoration />
      <Outlet />
    </>
  );
}

export const vtBackPatterns = urls(({ layout, path, transition }) => [
  layout(VtBackLayout, () => [
    path("/vt-back/list", List, { name: "vtBackList" }, () => [transition()]),
    path("/vt-back/detail/:id", Detail, { name: "vtBackDetail" }, () => [
      transition(),
    ]),
    path("/vt-back-plain/list", List, { name: "vtBackPlainList" }),
    path("/vt-back-plain/detail/:id", Detail, { name: "vtBackPlainDetail" }),
  ]),
]);
