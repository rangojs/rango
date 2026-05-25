import { urls, Meta } from "@rangojs/router";
import { RefreshDemoPage } from "../pages/refresh-demo.js";
import {
  RevenueLoader,
  ProductLoader,
  ProductsPageLoader,
  CartLoader,
} from "../handlers/refresh-demo/loaders.js";

/**
 * Client refresh-key / refresh-group showcase.
 *
 * RevenueLoader and ProductLoader are registered here so the shared-key cards
 * read them via useLoader() (SSR-seeded). ProductsPageLoader seeds the first
 * page of the products table; CartLoader seeds the cart badges. The group
 * loaders are unregistered fetch loaders used via useFetchLoader() in the cards.
 */
export const refreshDemoPatterns = urls(({ path, loader }) => [
  path(
    "/",
    (ctx) => {
      ctx.use(Meta)({ title: "Client Refresh" });
      return <RefreshDemoPage />;
    },
    { name: "index" },
    () => [
      loader(RevenueLoader),
      loader(ProductLoader),
      loader(ProductsPageLoader),
      loader(CartLoader),
    ],
  ),
]);
