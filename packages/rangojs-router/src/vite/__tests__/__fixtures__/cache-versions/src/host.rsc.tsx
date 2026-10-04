import { createHostRouter } from "@rangojs/router/host";

// Two apps behind one host router, each mounted lazily: the layout a host
// deploy uses, and the one the per-router cache versions have to keep apart.
const hostRouter = createHostRouter();
hostRouter.host(["a.localhost"]).lazy(() => import("./apps/a/handler.js"));
hostRouter.host(["b.localhost"]).lazy(() => import("./apps/b/handler.js"));

export default hostRouter;
