/// <reference types="@cloudflare/workers-types" />
import type { RouterEnv } from "@rangojs/router";

// Cloudflare Workers bindings
export interface AppBindings {
  // Add bindings as needed
}

// Middleware-injected variables
export interface AppVariables {
  requestId?: string;
  requestStart?: number;
  dateStart?: number;
}

// Combined app environment
export type AppEnv = RouterEnv<AppBindings, AppVariables>;

// Module augmentation for global type inference
declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
  }
}
