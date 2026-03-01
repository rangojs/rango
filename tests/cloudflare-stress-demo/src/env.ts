/// <reference types="@cloudflare/workers-types" />

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

// Module augmentation for global type inference
declare global {
  namespace RSCRouter {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
