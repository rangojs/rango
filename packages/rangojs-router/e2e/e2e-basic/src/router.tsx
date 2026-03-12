import { createRouter } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { urlpatterns } from "./urls.js";

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
  cache: { store: cacheStore },
}).routes(urlpatterns);
