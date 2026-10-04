/// <reference types="@cloudflare/workers-types" />
import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";
import { Document } from "../../document.js";
import { urlpatterns } from "./urls.js";

export const router = createRouter<{ KV: KVNamespace }>({
  document: Document,
  // No prefetch: a navigation in the suite has to reach the server, where the
  // reload check runs, instead of being answered from a prefetched response.
  defaultPrefetch: "none",
  // No `version`: the store keys with this router's own cache versions.
  cache: (env, ctx) => ({
    store: new CFCacheStore({ ctx: ctx!, kv: env.KV }),
  }),
}).routes(urlpatterns);
