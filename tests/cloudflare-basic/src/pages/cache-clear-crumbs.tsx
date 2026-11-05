import type { HandlerContext } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

/**
 * e2e/cache-clear-crumbs.test.ts. The layout's handler re-runs on every
 * navigation (revalidate(() => true)) and pushes its breadcrumb only when the
 * request's `?cc=1` asks for it, so a later render of the same handler pushes
 * nothing. A navigation that holds the layout must clear the crumb its
 * previous render pushed, on a HIT of the cache() record as on the MISS that
 * wrote it: the HIT sends the layout's stored copy, which pushed nothing, and
 * names it in resolvedIds.
 *
 * The layout's run count, shown on the page, tells the record's stored render
 * from a live one: two HITs of one record show the same count, a MISS the next
 * one.
 */
let layoutRuns = 0;

export function CacheClearCrumbsLayout(ctx: HandlerContext) {
  layoutRuns += 1;
  const breadcrumb = ctx.use(Breadcrumbs);
  if (ctx.searchParams.get("cc") === "1") {
    breadcrumb({ label: "layout", href: "/cache-clear-crumbs" });
  }
  return (
    <div data-testid="ccc-layout">
      <p data-testid="ccc-layout-runs">{layoutRuns}</p>
      <Outlet />
    </div>
  );
}

export function CacheClearCrumbsIndex() {
  return (
    <div data-testid="ccc-index">
      <Link
        to="/cache-clear-crumbs/item/a"
        prefetch="none"
        data-testid="ccc-link"
      >
        A
      </Link>
    </div>
  );
}

export function CacheClearCrumbsItem(ctx: HandlerContext<{ id: string }>) {
  return (
    <>
      <div data-testid="ccc-detail">detail {ctx.params.id}</div>
      <Link
        to="/cache-clear-crumbs?cc=1"
        prefetch="none"
        data-testid="ccc-back"
      >
        back
      </Link>
    </>
  );
}
