import { urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { StaleDefaultsCartLoader } from "./stale-defaults.defs.js";
import {
  countStaleDefaultsKeyedRender,
  countStaleDefaultsLayoutRender,
  readStaleDefaultsCart,
  readStaleDefaultsKeyed,
} from "./stale-defaults.store.js";
import {
  StaleDefaultsBar,
  StaleDefaultsIntercept,
  StaleDefaultsKeyedAdd,
} from "./stale-defaults.client.js";

// A layout whose loader reads a cart count, with no revalidate(), above two
// pages, a cache() page and an intercept, and an action that adds to the cart
// (stale-defaults.test.ts, semantic-matrix.test.ts R5). Page A's handler reads
// the cart too; the layout counts its renders. The cache() page, and a ppr
// page outside the layout (whose cookie reads would make the capture
// dynamic), show a count of their own and their renders, keyed by their ?k
// (also their record's and shell's key), as the sd-key cookie keys the rest.
// Mounted at /stale-defaults. Body:
// tests/shared-e2e/src/stale-defaults-scenario.ts.
function StaleDefaultsLayout() {
  return (
    <div data-testid="sd-layout">
      <p data-testid="sd-layout-renders">{`layout:${countStaleDefaultsLayoutRender()}`}</p>
      <StaleDefaultsBar />
      <Link to="/stale-defaults/b" prefetch="none" data-testid="sd-to-b">
        B
      </Link>
      <Link
        to="/stale-defaults/item/1"
        prefetch="none"
        data-testid="sd-open-item"
      >
        Item
      </Link>
      <Outlet />
      <Outlet name="@detail" />
    </div>
  );
}

const StaleDefaultsA: Handler = (ctx) => (
  <div data-testid="sd-a">
    <p data-testid="sd-a-cart">{`page:${readStaleDefaultsCart()}`}</p>
    <Link
      to={`/stale-defaults/cached?k=${ctx.searchParams.get("k") ?? ""}`}
      prefetch="none"
      data-testid="sd-to-cached"
    >
      Cached
    </Link>
  </div>
);

/** A page keyed by its ?k: `name` is "cached" or "shelled". */
function keyedPage(name: string): Handler {
  return (ctx) => {
    const k = ctx.searchParams.get("k") ?? "";
    return (
      <div data-testid={`sd-${name}`}>
        <p data-testid={`sd-${name}-count`}>
          {`${name}:${readStaleDefaultsKeyed(k)}`}
        </p>
        <p data-testid={`sd-${name}-render`}>
          {`render:${countStaleDefaultsKeyedRender(k)}`}
        </p>
        <StaleDefaultsKeyedAdd k={k} testId={`sd-${name}-add`} />
        <Link
          to="/stale-defaults/b"
          prefetch="none"
          data-testid={`sd-${name}-to-b`}
        >
          B
        </Link>
      </div>
    );
  };
}

export const staleDefaultsPatterns = urls(
  ({ layout, path, loader, intercept, cache }) => [
    layout(StaleDefaultsLayout, () => [
      loader(StaleDefaultsCartLoader),
      path("/", StaleDefaultsA, { name: "a" }),
      cache({ ttl: 300 }, () => [
        path("/cached", keyedPage("cached"), { name: "cached" }),
      ]),
      path("/b", () => <div data-testid="sd-b">B</div>, { name: "b" }),
      path("/item/:id", () => <div data-testid="sd-item-page">Item page</div>, {
        name: "item",
      }),
      intercept("@detail", ".item", (ctx) => (
        <StaleDefaultsIntercept id={ctx.params.id} />
      )),
    ]),
    path("/shelled", keyedPage("shelled"), { name: "shelled", ppr: true }),
  ],
);
