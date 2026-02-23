/// <reference types="@cloudflare/workers-types" />
import type { RouterEnv } from "@rangojs/router";

// Cloudflare Workers bindings
export interface AppBindings {}

// Middleware-injected variables
export interface AppVariables {}

// Combined app environment
export type AppEnv = RouterEnv<AppBindings, AppVariables>;

// Module augmentation for global type inference
declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
  }
}
