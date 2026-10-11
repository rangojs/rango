"use client";

/**
 * A clientUrls() group whose loaders declare revalidate(), as an app writes
 * one: the default export of a "use client" module. On the server it is a
 * client reference, and rangoUseClientTransform installs its projection with
 * its predicates, as discovery and the hoist plugin do in an app.
 */
import { clientUrls } from "../../../client-urls/client-urls.js";
import type { ClientUrlPatterns } from "../../../client-urls/types.js";
import {
  HeldLoader,
  ItemLoader,
  ResultLoader,
  ScopedLoader,
  resultAction,
} from "./client-urls-revalidate-data.js";

function ShopIndex(): null {
  return null;
}
function ShopItem(): null {
  return null;
}

const definition: ClientUrlPatterns = clientUrls(
  ({ path, loader, revalidate }) => [
    path("/", ShopIndex, { name: "index" }, () => [
      loader(ResultLoader, () => [
        revalidate(({ isAction, actionResult }) =>
          isAction(resultAction) ? actionResult?.ok === true : undefined,
        ),
      ]),
      loader(ScopedLoader, () => [
        revalidate(({ formData }) => formData?.get("scope") === "all"),
      ]),
    ]),
    path("/items/:id", ShopItem, { name: "item" }, () => [
      loader(HeldLoader, () => [
        revalidate(({ context, toRouteName }) =>
          context.get("flag" as never) === "on" && toRouteName === "shop.item"
            ? false
            : undefined,
        ),
      ]),
      loader(ItemLoader),
    ]),
  ],
);

export default definition;
