"use client";

/**
 * A clientUrls() group mounted under a server layout that opts in with
 * revalidate(). The group's layout() loader takes the same imported
 * predicate as that server layout, so chrome and its loader re-run on the
 * same requests. On the server it is a client reference, and
 * rangoUseClientTransform installs its projection with its predicates.
 */
import { clientUrls } from "../../../client-urls/client-urls.js";
import type { ClientUrlPatterns } from "../../../client-urls/types.js";
import {
  BadgeLoader,
  ItemLoader,
  chromeChanged,
} from "./client-urls-outer-layout-data.js";

function ShopLayout(): null {
  return null;
}
function ShopIndex(): null {
  return null;
}
function ShopItem(): null {
  return null;
}
function ShopCart(): null {
  return null;
}

const definition: ClientUrlPatterns = clientUrls(
  ({ layout, path, loader, revalidate }) => [
    layout(ShopLayout, () => [
      loader(BadgeLoader, () => [revalidate(chromeChanged)]),
      path("/", ShopIndex, { name: "index" }),
      path("/items/:id", ShopItem, { name: "item" }, () => [
        loader(ItemLoader),
      ]),
      path("/cart", ShopCart, { name: "cart" }),
    ]),
  ],
);

export default definition;
