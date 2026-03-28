import { createRouter } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { AppLayout } from "./components/layouts/index.js";
import { HomePage, AboutPage } from "./components/pages/index.js";
import { blogPatterns } from "./urls/blog.js";
import { shopPatterns } from "./urls/shop.js";
import { loaderTypePatterns } from "./urls/loader-types.js";

const cacheStore = new MemorySegmentCacheStore({
  defaults: { ttl: 60 },
});

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export const router = createRouter({
  basename: "/app",
  cache: { store: cacheStore },
}).routes(({ path, layout, include }) => [
  layout(AppLayout, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
    include("/blog", blogPatterns, { name: "blog" }),
    include("/shop", shopPatterns, { name: "shop" }),
    include("/loader-types", loaderTypePatterns, { name: "loaderTypes" }),
  ]),
]);
