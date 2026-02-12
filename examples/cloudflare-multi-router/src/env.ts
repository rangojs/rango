/// <reference types="@cloudflare/workers-types" />
import type { RouterEnv } from "@rangojs/router";

// No bindings needed for this multi-router example
export interface AppBindings {}

export interface AppVariables {}

export type AppEnv = RouterEnv<AppBindings, AppVariables>;
