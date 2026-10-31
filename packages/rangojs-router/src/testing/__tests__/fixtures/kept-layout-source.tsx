"use client";

/**
 * The #1331 shop group: PLPs, a product page and /cart, mounted below a
 * server layout whose revalidate() reads the source page's params
 * (kept-layout-source-prefetch.rsc-test.tsx).
 */
import { clientUrls } from "../../../client-urls/client-urls.js";
import type { ClientUrlPatterns } from "../../../client-urls/types.js";

function Plp(): null {
  return null;
}
function Product(): null {
  return null;
}
function Cart(): null {
  return null;
}

const definition: ClientUrlPatterns = clientUrls(({ path }) => [
  path("/c/:category", Plp, { name: "plp" }),
  path("/p/:productId", Product, { name: "product" }),
  path("/cart", Cart, { name: "cart" }),
]);

export default definition;
