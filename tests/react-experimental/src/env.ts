/// <reference types="@cloudflare/workers-types" />

// Cloudflare Workers bindings
export interface AppBindings {}

// Middleware-injected variables
export interface AppVariables {}

// Module augmentation for global type inference
declare global {
  namespace RSCRouter {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
