import { createRouter } from "@rangojs/router";
import { appCache } from "../../cache.js";
import { Document } from "./document.js";
import { adminPatterns } from "./urls.js";
import type { AppBindings } from "../../env.js";

export const router = createRouter<AppBindings>({
  document: Document,
  cache: appCache,
}).routes(adminPatterns);
