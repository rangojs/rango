import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";

import { Document } from "./document";
import type { AppEnv } from "./env";
import { urlpatterns } from "./urls";

// Docs pages are fully static per URL, so shells can live long. The store is
// namespaced by worker version (CF_VERSION_METADATA), so a new deploy always
// starts from a clean cache; in dev, miniflare's cache is process-local and
// resets with the dev server.
const defaults = { ttl: 3600, swr: 86_400 };

export const router = createRouter<AppEnv>({
  document: Document,
  theme: {
    attribute: "class",
    defaultTheme: "system",
    themes: ["light", "dark"],
  },
  // L1 Cache API only for now — no KV binding until the site has a real
  // deployment; ctx is always provided on Workers (and by miniflare in dev).
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      defaults,
      ctx: ctx!,
      namespace: env?.CF_VERSION_METADATA?.id,
    }),
    enabled: true,
  }),
}).routes(urlpatterns);

export const reverse = router.reverse;
export default router;

declare global {
  namespace Rango {
    interface Env extends AppEnv {}
  }
}
