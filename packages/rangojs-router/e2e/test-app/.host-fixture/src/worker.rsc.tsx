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
hostRouter.host(["a.localhost"]).lazy(() => import("./apps/a/handler.js"));
hostRouter.host(["b.localhost"]).lazy(() => import("./apps/b/handler.js"));

export default hostRouter;
