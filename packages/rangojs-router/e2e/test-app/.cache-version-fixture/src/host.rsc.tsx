import { createHostRouter } from "@rangojs/router/host";

// The e2e picks the app with the host-override cookie on one localhost origin,
// like e2e/test-app/.host-fixture.
const hostRouter = createHostRouter({
  hostOverride: { cookieName: "x-rango-host", allowedHosts: ["localhost"] },
});
hostRouter.host(["a.localhost"]).lazy(() => import("./apps/a/handler.js"));
hostRouter.host(["b.localhost"]).lazy(() => import("./apps/b/handler.js"));

export default hostRouter;
