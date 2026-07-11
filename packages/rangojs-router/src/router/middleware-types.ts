import type { ContextVar } from "../context-var.js";
import type {
  DefaultReverseRouteMap,
  DefaultRouteName,
  DefaultVars,
} from "../types/global-namespace.js";
import type { ScopedReverseFunction } from "../reverse.js";
import type { Theme } from "../theme/types.js";
import type { LocationStateEntry } from "../browser/react/location-state-shared.js";
import type { RequestScope } from "../types/request-scope.js";

type GetVariableFn = {
  <T>(contextVar: ContextVar<T>): T | undefined;
  <K extends keyof DefaultVars>(key: K): DefaultVars[K];
};

type SetVariableFn = {
  <T>(contextVar: ContextVar<T>, value: T, options?: { cache?: boolean }): void;
  <K extends keyof DefaultVars>(
    key: K,
    value: DefaultVars[K],
    options?: { cache?: boolean },
  ): void;
};

export interface CookieOptions {
  domain?: string;
  path?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
}

export interface MiddlewareContext<
  TEnv = any,
  TParams = Record<string, string | undefined>,
> extends RequestScope<TEnv> {
  params: TParams;

  /**
   * True for build-time render/capture requests. Live requests use false.
   * Build-time PPR shell capture sets this while replaying middleware.
   */
  readonly build: boolean;

  /**
   * Opt this request out of PPR shell serving/capture.
   * During middleware this runs before the shell HIT commit point, so it can
   * force the request onto the dynamic axis.
   *
   * Scope: the PPR SHELL axis only. It does NOT disable prerender B-segment
   * (Prerender/Static) serving — a Prerender() route still replays its
   * build-baked segments at runtime.
   */
  dynamic(): void;

  readonly headers: Headers;

  get: GetVariableFn;

  set: SetVariableFn;

  header(name: string, value: string): void;

  routeName?: DefaultRouteName;

  debugPerformance(): void;

  theme?: Theme;

  setTheme?: (theme: Theme) => void;

  setLocationState(entries: LocationStateEntry | LocationStateEntry[]): void;

  reverse: ScopedReverseFunction<
    Record<string, string>,
    DefaultReverseRouteMap
  >;
}

export type MiddlewareFn<
  TEnv = any,
  TParams = Record<string, string | undefined>,
> = (
  ctx: MiddlewareContext<TEnv, TParams>,
  next: () => Promise<Response>,
) => Response | void | Promise<Response | void>;

export interface MiddlewareEntry<TEnv = any> {
  pattern: string | null;
  regex: RegExp | null;
  paramNames: string[];
  handler: MiddlewareFn<TEnv>;
}

export interface ResponseHolder {
  response: Response | null;
}

export interface MiddlewareCollectableEntry {
  middleware?: MiddlewareFn<any, any>[];
  layout?: MiddlewareCollectableEntry[];
}

export interface CollectedMiddleware {
  handler: MiddlewareFn<any, any>;
  params: Record<string, string>;
}
