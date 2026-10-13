"use client";

/**
 * A clientUrls() group whose layout() declares loaders with revalidate(), as
 * an app writes one: the default export of a "use client" module. On the
 * server it is a client reference, and rangoUseClientTransform installs its
 * projection with its predicates, as discovery and the hoist plugin do.
 */
import { clientUrls } from "../../../client-urls/client-urls.js";
import type { ClientUrlPatterns } from "../../../client-urls/types.js";
import {
  ActionLoader,
  DefaultLoader,
  FlaggedDefaultLoader,
  FlaggedLoader,
  ForcedLoader,
  HeldLoader,
  ItemLoader,
  ParamsLoader,
  SeenLoader,
  bumpAction,
  recordDefault,
} from "./client-urls-layout-revalidate-data.js";

function ShopLayout(): null {
  return null;
}
function ShopIndex(): null {
  return null;
}
function ShopAbout(): null {
  return null;
}
function ShopItem(): null {
  return null;
}
function Outside(): null {
  return null;
}

const definition: ClientUrlPatterns = clientUrls(
  ({ layout, path, loader, revalidate }) => [
    layout(ShopLayout, () => [
      loader(HeldLoader, () => [revalidate(() => false)]),
      loader(ActionLoader, () => [
        revalidate(({ isAction }) => isAction(bumpAction)),
      ]),
      loader(ForcedLoader, () => [revalidate(() => true)]),
      loader(DefaultLoader),
      loader(ParamsLoader, () => [
        revalidate(
          ({ currentParams, nextParams }) => currentParams.id !== nextParams.id,
        ),
      ]),
      loader(SeenLoader, () => [
        revalidate(({ defaultShouldRevalidate }) =>
          recordDefault(defaultShouldRevalidate),
        ),
      ]),
      loader(FlaggedLoader, { prefetch: false }, () => [
        revalidate(() => true),
      ]),
      loader(FlaggedDefaultLoader, { prefetch: false }),
      path("/", ShopIndex, { name: "index" }),
      path("/about", ShopAbout, { name: "about" }),
      path("/items/:id", ShopItem, { name: "item" }, () => [
        loader(ItemLoader),
      ]),
    ]),
    // In the group, outside the layout.
    path("/outside", Outside, { name: "outside" }),
  ],
);

export default definition;
