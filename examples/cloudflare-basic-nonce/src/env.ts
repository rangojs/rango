/// <reference types="@cloudflare/workers-types" />

// Cloudflare Workers bindings (D1, KV, etc.)
export interface AppBindings {
  KV: KVNamespace;
  // DB?: D1Database;
}

// Middleware-injected variables
export interface AppVariables {
  requestId?: string;
  nonce?: string; // CSP nonce injected by RSC handler
}

// Module augmentation for global type inference
declare global {
  namespace RSCRouter {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
