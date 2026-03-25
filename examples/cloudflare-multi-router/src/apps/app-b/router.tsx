import { createRouter } from "@rangojs/router";
import { Document } from "./document.js";
import { appBPatterns } from "./urls.js";
import type { AppBindings } from "../../env.js";

export const router = createRouter<AppBindings>({
  document: Document,
}).routes(appBPatterns);
