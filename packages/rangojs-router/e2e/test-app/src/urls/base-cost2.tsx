import * as React from "react";
import { urls, createLoader } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { BaseCostValue } from "../components/BaseCost.js";

const VT: any =
  "ViewTransition" in React ? (React as any).ViewTransition : null;

const run = async (ctx: any) => {
  const delay = Number(ctx.searchParams.get("delay") ?? 0) || 0;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  return { delay };
};
export const BcOwnLoader = createLoader(run);
export const BcOwnLayoutLoader = createLoader(run);

const fb = (id: string) => <div data-testid={id}>loading {id}</div>;
const DELAYS = [100, 300, 500];

function makeHub(prefix: string, prefetch: "none" | "render") {
  const link = (to: string, id: string) => (
    <Link
      key={id}
      to={`${prefix}${to}`}
      prefetch={
        prefix === "/base-cost-q"
          ? id === "bc-link-nl-a"
            ? "render"
            : "none"
          : prefetch
      }
      data-testid={id}
    >
      {id}
    </Link>
  );
  return () => (
    <div data-testid="bc-hub">
      {link("/noloader", "bc-link-noloader")}
      {link("/noloader-layout/a", "bc-link-nl-a")}
      {link("/noloader-layout/b", "bc-link-nl-b")}
      {link("/own-vt-sib", "bc-link-own-vt-sib")}
      {DELAYS.flatMap((d) => [
        link(`/own-vt?delay=${d}`, `bc-link-own-vt-${d}`),
        link(`/own-vt-layout?delay=${d}`, `bc-link-own-vt-layout-${d}`),
      ])}
      <div data-testid="bc-outlet">
        <Outlet />
      </div>
    </div>
  );
}

const NlLayout = () => (
  <div data-testid="bc-nl-layout">
    <Outlet />
  </div>
);
const OwnVtLayout = () => (
  <VT>
    <div data-testid="bc-ovl-layout">
      <Outlet />
    </div>
  </VT>
);

function make(prefix: string, prefetch: "none" | "render") {
  return urls(({ path, layout, loader, loading }) => [
    layout(makeHub(prefix, prefetch), () => [
      path("/", () => <div data-testid="bc-index">hub</div>, { name: "index" }),
      path(
        "/noloader",
        () => <div data-testid="bc-nl-done">noloader done</div>,
        { name: "noloader" },
        () => [loading(fb("bc-fb"))],
      ),
      layout(NlLayout, () => [
        loading(fb("bc-fb-outer")),
        path("/noloader-layout/a", () => <div data-testid="bc-nl-a">a</div>, {
          name: "nlA",
        }),
        path("/noloader-layout/b", () => <div data-testid="bc-nl-b">b</div>, {
          name: "nlB",
        }),
      ]),
      path(
        "/own-vt",
        () => (
          <VT>
            <div data-testid="bc-own-page">
              <BaseCostValue loader={BcOwnLoader} testId="bc-value" />
            </div>
          </VT>
        ),
        { name: "ownVt" },
        () => [loader(BcOwnLoader), loading(fb("bc-fb"))],
      ),
      layout(OwnVtLayout, () => [
        loading(fb("bc-fb")),
        path("/own-vt-sib", () => <div data-testid="bc-sib">sib</div>, {
          name: "ownVtSib",
        }),
        path(
          "/own-vt-layout",
          () => (
            <div data-testid="bc-own-page">
              <BaseCostValue loader={BcOwnLayoutLoader} testId="bc-value" />
            </div>
          ),
          { name: "ownVtLayout" },
          () => [loader(BcOwnLayoutLoader)],
        ),
      ]),
    ]),
  ]);
}

export const baseCostAPatterns = make("/base-cost-a", "none");
export const baseCostPPatterns = make("/base-cost-p", "render");

export const baseCostQPatterns = make("/base-cost-q", "none");
