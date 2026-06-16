import { createHostRouter } from "@rangojs/router/host";

// node/vercel preset: export the HostRouter instance; rango's generated entry
// serves it via hostRouter.match(). No catch-all, so an unmatched host exercises
// the generated entry's NoRouteMatchError -> 404 path.
const hostRouter = createHostRouter();
hostRouter.host(["a.localhost"]).lazy(() => import("./apps/a/handler.js"));
hostRouter.host(["b.localhost"]).lazy(() => import("./apps/b/handler.js"));

export default hostRouter;
