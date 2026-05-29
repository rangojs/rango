/// <reference types="@cloudflare/workers-types" />

// No bindings needed for this multi-router example
export interface AppBindings {}

export interface AppVariables {}

// Module augmentation for global type inference
declare global {
  namespace Rango {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
