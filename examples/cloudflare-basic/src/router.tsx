import { createRSCRouter, type RouterEnv } from "rsc-router/server";
import { homeRoutes, aboutRoutes, counterRoutes } from "./routes.js";
import { AppShell } from "./components/AppShell.js";

// Cloudflare Workers bindings (D1, KV, etc.)
export interface AppBindings {
  // Add your bindings here:
  // DB?: D1Database;
  // KV?: KVNamespace;
}

// Middleware-injected variables
export interface AppVariables {
  requestId?: string;
}

// Combined app environment
export type AppEnv = RouterEnv<AppBindings, AppVariables>;

// Module augmentation for global type inference
declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
  }
}

// Create the router with document component
// AppShell wraps both route content and error boundaries,
// preventing the app shell from unmounting during errors (avoids FOUC)
export const router = createRSCRouter<AppEnv>({
  document: AppShell,
});

// Register routes with lazy-loaded handlers
router
  .routes(homeRoutes)
  .map(() => import("./handlers/home.js"))

  .routes(aboutRoutes)
  .map(() => import("./handlers/about.js"))

  .routes(counterRoutes)
  .map(() => import("./handlers/counter.js"));

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}
