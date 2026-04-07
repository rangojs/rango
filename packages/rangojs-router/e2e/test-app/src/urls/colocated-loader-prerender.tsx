import { urls } from "@rangojs/router";
import { Outlet, Link } from "@rangojs/router/client";
import { ColocatedClient } from "../components/ColocatedClient.js";
import {
  ColocatedLoader,
  ColocatedHandle,
  ColocatedPrerender,
  ColocatedStatic,
} from "./colocated-loader-prerender.defs.js";

// ─── Fresh handler ───────────────────────────────────────────────────────

function FreshPage(ctx: any) {
  const push = ctx.use(ColocatedHandle);
  push("fresh-item");

  return (
    <div data-testid="colocated-fresh-page">
      <h1 data-testid="colocated-fresh-title">Colocated Fresh</h1>
      <p data-testid="colocated-fresh-pushed">fresh-item</p>
      <ColocatedClient />
      <Link to="/colocated-lp/prerender" data-testid="colocated-link-prerender">
        Go to Prerender
      </Link>
    </div>
  );
}

// ─── Layout ──────────────────────────────────────────────────────────────

function ColocatedLayout() {
  return (
    <div data-testid="colocated-layout">
      <Outlet />
    </div>
  );
}

// ─── URL patterns ────────────────────────────────────────────────────────

export const colocatedLoaderPrerenderPatterns = urls(
  ({ path, layout, loader }) => [
    layout(ColocatedLayout, () => [
      path("/fresh", FreshPage, { name: "fresh" }, () => [
        loader(ColocatedLoader),
      ]),
      path("/prerender", ColocatedPrerender, { name: "prerender" }, () => [
        loader(ColocatedLoader),
      ]),
      path("/static", ColocatedStatic, { name: "static" }),
    ]),
  ],
);
