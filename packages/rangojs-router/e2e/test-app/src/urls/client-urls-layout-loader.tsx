"use client";

import { Suspense } from "react";
import {
  clientUrls,
  Link,
  useHandle,
  useLoader,
  useOutlet,
} from "@rangojs/router/client";
import {
  ClientLayoutCartLoader,
  ClientLayoutCrumbs,
  ClientLayoutItemLoader,
  ClientLayoutRunsLoader,
} from "./client-urls-layout-loader.loader.js";
import {
  bumpClientLayoutCart,
  rerunClientLayoutRuns,
} from "./client-urls-layout-loader.actions.js";

// A group layout that reads its own layout() loader, directly and in an
// inline <Suspense> (the vite-rsc-demo ClientShopLayout / CartBadge shape),
// behind a 400 ms server middleware (urls.tsx), and a layout() loader whose
// default holds on every navigation, read and pushing a crumb. Body:
// tests/shared-e2e/src/client-urls-layout-loader-scenario.ts.

function CartBadge() {
  const { data } = useLoader(ClientLayoutCartLoader);
  return <span data-testid="cll-badge">{data}</span>;
}

function ShopLayout() {
  const { content, pending } = useOutlet();
  const { data } = useLoader(ClientLayoutCartLoader);
  const { data: runs } = useLoader(ClientLayoutRunsLoader);
  const crumbs = useHandle(ClientLayoutCrumbs) ?? [];
  return (
    <section data-testid="cll-layout" data-pending={String(pending)}>
      <p data-testid="cll-cart">{data}</p>
      <p data-testid="cll-runs">{runs}</p>
      <p data-testid="cll-crumbs">{crumbs.join(" ")}</p>
      <Suspense
        fallback={<span data-testid="cll-badge-fallback">loading cart</span>}
      >
        <CartBadge />
      </Suspense>
      <button
        data-testid="cll-bump"
        onClick={() => void bumpClientLayoutCart()}
      >
        Add item
      </button>
      <button
        data-testid="cll-rerun"
        onClick={() => void rerunClientLayoutRuns()}
      >
        Refresh runs
      </button>
      {content}
    </section>
  );
}

function ShopIndex() {
  return (
    <div data-testid="cll-index">
      <Link
        to="/client-urls-layout-loader/items/alpha"
        prefetch="none"
        data-testid="cll-to-alpha"
      >
        Alpha
      </Link>
      <Link
        to="/client-urls-layout-loader/items/gamma"
        prefetch="none"
        data-testid="cll-to-gamma"
      >
        Gamma
      </Link>
    </div>
  );
}

function ShopItem() {
  const { data } = useLoader(ClientLayoutItemLoader);
  return (
    <div data-testid="cll-item">
      <p data-testid="cll-item-data">{data}</p>
      <Link
        to="/client-urls-layout-loader/items/beta"
        prefetch="none"
        data-testid="cll-to-beta"
      >
        Beta
      </Link>
      <Link
        to="/client-urls-layout-loader/items/alpha?view=compact"
        prefetch="none"
        data-testid="cll-to-alpha-compact"
      >
        Compact
      </Link>
      <Link
        to="/client-urls-layout-loader"
        prefetch="none"
        data-testid="cll-to-index"
      >
        Index
      </Link>
    </div>
  );
}

export default clientUrls(({ layout, path, loader, loading }) => [
  layout(ShopLayout, () => [
    loader(ClientLayoutCartLoader),
    loader(ClientLayoutRunsLoader),
    path("/", ShopIndex, { name: "index" }),
    path("/items/:id", ShopItem, { name: "item" }, () => [
      loader(ClientLayoutItemLoader),
      loading(<p data-testid="cll-item-loading">loading item</p>),
    ]),
  ]),
]);
