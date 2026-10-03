/// <reference types="@cloudflare/workers-types" />
import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";
import { Document } from "../../document.js";
import { urlpatterns } from "./urls.js";

export const router = createRouter<{ KV: KVNamespace }>({
  document: Document,
  defaultPrefetch: "none",
  cache: (env, ctx) => ({
    store: new CFCacheStore({ ctx: ctx!, kv: env.KV }),
  }),
}).routes(urlpatterns);
