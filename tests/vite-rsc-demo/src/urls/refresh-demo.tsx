import { urls, Meta } from "@rangojs/router";
import { RefreshDemoPage } from "../pages/refresh-demo.js";
import { RevenueLoader } from "../handlers/refresh-demo/loaders.js";

/**
 * Client refresh-key / refresh-group showcase.
 *
 * RevenueLoader is registered here so the shared-key cards read it via
 * useLoader() (SSR-seeded). The group loaders are unregistered fetch loaders
 * used via useFetchLoader() in the cards themselves.
 */
export const refreshDemoPatterns = urls(({ path, loader }) => [
  path(
    "/",
    (ctx) => {
      ctx.use(Meta)({ title: "Client Refresh" });
      return <RefreshDemoPage />;
    },
    { name: "index" },
    () => [loader(RevenueLoader)],
  ),
]);
