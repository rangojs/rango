/// <reference types="@cloudflare/workers-types" />

// Cloudflare Workers bindings (D1, KV, etc.)
export interface AppBindings {
  KV: KVNamespace;
  // On-demand prerender overlay store (see src/router.tsx `prerender` option).
  PRERENDER_KV: KVNamespace;
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
