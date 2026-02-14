import { createRouter } from "@rangojs/router";
import { Document } from "./document.js";
import { sitePatterns } from "./urls.js";
import type { AppEnv } from "../../env.js";

export const router = createRouter<AppEnv>({
  debug: true,
  document: Document,
}).routes(sitePatterns);
