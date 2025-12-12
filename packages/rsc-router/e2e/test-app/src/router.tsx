import { createRSCRouter, type RouterEnv } from "rsc-router/server";
import { testRoutes } from "./routes.js";

export type AppEnv = RouterEnv<{}, {}>;

declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
  }
}

export const router = createRSCRouter<AppEnv>()
  .routes(testRoutes)
  .map(() => import("./handlers.js"));

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export const href = router.href;
