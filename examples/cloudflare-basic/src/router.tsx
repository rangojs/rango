import { createRSCRouter, type RouterEnv } from "rsc-router/server";
import { homeRoutes, aboutRoutes, counterRoutes } from "./routes.js";

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

// Create the router
export const router = createRSCRouter<AppEnv>();

// Register routes with lazy-loaded handlers
router
  .routes(homeRoutes)
  .map(() => import("./handlers/home.js"))

  .routes(aboutRoutes)
  .map(() => import("./handlers/about.js"))

  .routes(counterRoutes)
  .map(() => import("./handlers/counter.js"));
