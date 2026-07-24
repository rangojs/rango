import { createRouter } from "@rangojs/router";
import clientUrlPatterns from "./client-urls/urls.js";
import { Document } from "./document.js";
import type { AppBindings } from "./env.js";

export const clientUrlsRouter = createRouter<AppBindings>({
  id: "cloudflare-basic-client-urls",
  document: Document,
}).routes(clientUrlPatterns);
