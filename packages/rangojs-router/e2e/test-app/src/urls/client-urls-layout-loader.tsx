"use client";

import { Suspense } from "react";
import { clientUrls, Link, useLoader, useOutlet } from "@rangojs/router/client";
import {
  ClientLayoutCartLoader,
  ClientLayoutItemLoader,
} from "./client-urls-layout-loader.loader.js";
import { bumpClientLayoutCart } from "./client-urls-layout-loader.actions.js";

// A group layout that reads its own layout() loader, directly and in an
// inline <Suspense> (the vite-rsc-demo ClientShopLayout / CartBadge shape),
// behind a 400 ms server middleware (urls.tsx). Body:
// tests/shared-e2e/src/client-urls-layout-loader-scenario.ts.

function CartBadge() {
  const { data } = useLoader(ClientLayoutCartLoader);
  return <span data-testid="cll-badge">{data}</span>;
}

function ShopLayout() {
  const { content, pending } = useOutlet();
  const { data } = useLoader(ClientLayoutCartLoader);
  return (
    <section data-testid="cll-layout" data-pending={String(pending)}>
      <p data-testid="cll-cart">{data}</p>
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
    path("/", ShopIndex, { name: "index" }),
    path("/items/:id", ShopItem, { name: "item" }, () => [
      loader(ClientLayoutItemLoader),
      loading(<p data-testid="cll-item-loading">loading item</p>),
    ]),
  ]),
]);
