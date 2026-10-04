import { createRouter } from "@rangojs/router";
import { VercelCacheStore } from "@rangojs/router/cache";
import { Document } from "../../document.js";
import { fileCache } from "../../file-cache.js";
import { urlpatterns } from "./urls.js";

export const router = createRouter({
  document: Document,
  defaultPrefetch: "none",
  cache: () => ({ store: new VercelCacheStore({ cache: fileCache }) }),
}).routes(urlpatterns);
