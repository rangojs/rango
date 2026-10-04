import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";

// A comment above the call: a build drops it from the transformed module and
// build-time discovery keeps it, so an id taken from the transformed line
// would differ between the two (cache-versions-build.test.ts).
export const router = createRouter({}).routes(urlpatterns);
