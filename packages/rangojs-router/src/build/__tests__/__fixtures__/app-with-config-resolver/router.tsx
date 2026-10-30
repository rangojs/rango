import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
export const router = createRouter().routes(urlpatterns);
