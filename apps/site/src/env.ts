/// <reference types="@cloudflare/workers-types" />
import type { RouterEnv } from "@rangojs/router";

export interface AppBindings {}

export interface AppVariables {}

export type AppEnv = RouterEnv<AppBindings, AppVariables>;

declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
  }
}
