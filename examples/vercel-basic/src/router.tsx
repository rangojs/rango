import { createRouter } from "@rangojs/router";
import {
  MemorySegmentCacheStore,
  VercelCacheStore,
} from "@rangojs/router/cache";
import { getCache, waitUntil } from "@vercel/functions";
import { Document } from "./components/Document.js";
import { HomePage } from "./components/pages/HomePage.js";
import { AboutPage } from "./components/pages/AboutPage.js";
import { CachedTimePage } from "./components/pages/CachedTimePage.js";

const defaults = { ttl: 60, swr: 300 };

// Local dev/preview has no Vercel Runtime Cache, so fall back to the in-memory
// store there. On Vercel (process.env.VERCEL is set by the platform) use the
// Runtime Cache store, namespaced by the deployment id so a redeploy does not
// serve stale-shaped entries (Vercel does not reconcile TTL/tags across deploys).
const memoryStore = new MemorySegmentCacheStore({ defaults });

function resolveCache() {
  if (process.env.VERCEL) {
    return {
      store: new VercelCacheStore({
        cache: getCache({ namespace: process.env.VERCEL_DEPLOYMENT_ID }),
        waitUntil,
        defaults,
      }),
    };
  }
  return { store: memoryStore };
}

type AppRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export const router = createRouter({
  document: Document,
  cache: resolveCache,
}).routes(({ path, cache }) => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),
  cache({ ttl: 10, swr: 30, tags: ["time"] }, () => [
    path("/cached", CachedTimePage, { name: "cached" }),
  ]),
]);
