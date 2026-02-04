/// <reference types="@cloudflare/workers-types" />
import type { RouterEnv } from "@rangojs/router/server";

// Cloudflare Workers bindings
export interface AppBindings {
  // Add bindings as needed
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
