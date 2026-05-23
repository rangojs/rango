/// <reference types="@cloudflare/workers-types" />

// Cloudflare Workers bindings (D1, KV, etc.)
export interface AppBindings {
  KV: KVNamespace;
  // DB?: D1Database;
}

// Middleware-injected variables
export interface AppVariables {
  requestId?: string;
}

// Module augmentation for global type inference
declare global {
  namespace Rango {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
