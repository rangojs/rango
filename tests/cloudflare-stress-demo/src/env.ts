/// <reference types="@cloudflare/workers-types" />

// Cloudflare Workers bindings
export interface AppBindings {
  /**
   * Set to "1" to populate matchStats via enableMatchDebug. Off by default:
   * the debug path adds per-request work in the regex fallback matcher and
   * pollutes benchmark numbers (see BENCHMARK.md).
   */
  MATCH_DEBUG?: string;
}

// Middleware-injected variables
export interface AppVariables {
  requestId?: string;
  requestStart?: number;
  dateStart?: number;
  sessionId?: string;
  locale?: string;
}

// Module augmentation for global type inference
declare global {
  namespace Rango {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
