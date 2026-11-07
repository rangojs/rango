import { createHostRouter } from "@rangojs/router/host";

// node/vercel preset: export the HostRouter instance; rango's generated entry
// serves it via hostRouter.match(). No catch-all, so an unmatched host exercises
// the generated entry's NoRouteMatchError -> 404 path.
//
// hostOverride is the supported dev workflow (pick a host via cookie from one
// origin). The e2e drives routing on a single localhost origin through this
// cookie so client modules load same-origin and hydration works in dev too.
const hostRouter = createHostRouter({
  hostOverride: { cookieName: "x-rango-host", allowedHosts: ["localhost"] },
});
// App B is also mounted on app A's host under /b-mount: a link from app A
// into it crosses apps on one origin, which is a document navigation.
hostRouter
  .host(["a.localhost/b-mount"])
  .lazy(() => import("./apps/b/handler.js"));
hostRouter.host(["a.localhost"]).lazy(() => import("./apps/a/handler.js"));
hostRouter.host(["b.localhost"]).lazy(() => import("./apps/b/handler.js"));

export default hostRouter;
