/// <reference types="@cloudflare/workers-types" />

// Cloudflare Workers bindings
export interface AppBindings {}

// Middleware-injected variables
export interface AppVariables {}

export type AppEnv = AppBindings;

// Module augmentation for global type inference
declare global {
  namespace Rango {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
