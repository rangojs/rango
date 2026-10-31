"use client";

/**
 * The #1331 reporter's shop group: a category PLP, a product page with its
 * loader, /cart and /search, mounted below the category template
 * (source-independence.rsc-test.tsx).
 */
import { clientUrls } from "../../../client-urls/client-urls.js";
import type { ClientUrlPatterns } from "../../../client-urls/types.js";
import { ProductLoader } from "./source-independence-data.js";

function Plp(): null {
  return null;
}
function Product(): null {
  return null;
}
function Cart(): null {
  return null;
}
function Search(): null {
  return null;
}

const definition: ClientUrlPatterns = clientUrls(({ path, loader }) => [
  path("/c/:category", Plp, { name: "plp" }),
  path("/:productId.html", Product, { name: "product" }, () => [
    loader(ProductLoader),
  ]),
  path("/cart", Cart, { name: "cart" }),
  path("/search", Search, { name: "search" }),
]);

export default definition;
