/// <reference types="@cloudflare/workers-types" />

// Cloudflare Workers bindings (D1, KV, etc.)
export interface AppBindings {
  KV: KVNamespace;
  /** Cloudflare zone purge credentials; configure both or neither. */
  CF_TAG_PURGE_ENABLED?: string;
  CF_ZONE_ID?: string;
  CF_PURGE_TOKEN?: string;
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
