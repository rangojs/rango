/**
 * Shared internals for the consumer testing primitives.
 *
 * Builds a real RequestContext via the same createRequestContext the RSC
 * handler uses, with test-friendly defaults, so loaders and middleware run
 * with production-fidelity context (cookies, headers, get/set, use, reverse)
 * instead of a hand-rolled mock.
 */

import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { createReverseFunction } from "../../router/handler-context.js";
import { normalizeBasename } from "../../router/basename.js";
import { contextSet, type ContextVar } from "../../context-var.js";
import type { ThemeConfig } from "../../theme/types.js";
import { resolveThemeConfig } from "../../theme/constants.js";
import type { SegmentCacheStore } from "../../cache/types.js";
import type { CacheProfile } from "../../cache/profile-registry.js";

const DEFAULT_ORIGIN = "http://localhost/";

/**
 * Initializer for seeded context variables (as a prior middleware would have
 * set). Either a plain object keyed by var name (the common, best-inferring
 * form: `{ user: u }`) or a list of `[key, value]` tuples where the key may be a
 * `createVar()` handle or a string (`[[userVar, u], ["flag", true]]`).
 */
export type VarsInit =
  | Record<string, unknown>
  | ReadonlyArray<readonly [ContextVar<unknown> | string, unknown]>;

/** Normalize a Request | string | undefined into a concrete Request. */
export function toRequest(
  request: Request | string | undefined,
  init?: RequestInit,
): Request {
  if (request instanceof Request) return request;
  if (typeof request === "string") {
    return new Request(new URL(request, DEFAULT_ORIGIN), init);
  }
  return new Request(DEFAULT_ORIGIN, init);
}

/**
 * Preload variables as if set by upstream middleware. Accepts entries keyed by
 * either a ContextVar (from createVar) or a string, matching ctx.set().
 */
export function seedVariables(
  variables: Record<string, unknown>,
  vars?: VarsInit,
): Record<string, unknown> {
  if (!vars) return variables;
  // Array/iterable form -> use the tuples as-is; plain object -> its entries.
  const entries: Iterable<readonly [ContextVar<unknown> | string, unknown]> =
    Symbol.iterator in (vars as object)
      ? (vars as ReadonlyArray<
          readonly [ContextVar<unknown> | string, unknown]
        >)
      : Object.entries(vars as Record<string, unknown>);
  for (const [key, value] of entries) {
    contextSet(variables, key as ContextVar<unknown>, value);
  }
  return variables;
}

export interface CreateTestContextOptions<TEnv> {
  env?: TEnv;
  request?: Request | string;
  requestInit?: RequestInit;
  /** Backing store for ctx.get()/ctx.set(); pre-seeded from `vars`. */
  variables?: Record<string, unknown>;
  /** Variables a prior middleware would have set (object or [key, value] list). */
  vars?: VarsInit;
  /** Route name -> pattern map enabling ctx.reverse() without global state. */
  routeMap?: Record<string, string>;
  routeName?: string;
  params?: Record<string, string>;
  /**
   * Router basename for this request (what the RSC handler stores on the
   * context). Drives redirect() prefixing. Normalized exactly like
   * createRouter({ basename }) (leading slash forced, trailing stripped, bare
   * "/" -> undefined) so passing the same value your router takes yields the
   * same redirect Location. Defaults to undefined (no basename).
   */
  basename?: string;
  /**
   * Cache store backing `use cache` functions invoked during the test, the
   * same shape `createRouter({ cache })` resolves. Without it,
   * registerCachedFunction bypasses (it checks for a store FIRST), so a cached
   * function runs uncached and its taint/profile guards never fire. Wire one
   * (e.g. `new MemorySegmentCacheStore()`) to exercise real cache behavior.
   */
  cacheStore?: SegmentCacheStore;
  /**
   * Cache profiles in the `createRouter({ cacheProfiles })` shape. Required for
   * a `use cache: "profileName"` function to resolve its profile (an unknown
   * profile throws), once a `cacheStore` is wired.
   */
  cacheProfiles?: Record<string, CacheProfile>;
  /**
   * Theme config in the same shape `createRouter({ theme })` takes (resolved
   * internally). Without it `ctx.theme`/`ctx.setTheme` are inert (undefined),
   * mirroring an app with no theme configured. Pass one (e.g. `true`, or
   * `{ themes: [...] }`) to exercise a handler that reads them.
   */
  theme?: ThemeConfig | true;
}

export interface TestRequestContext<TEnv> {
  ctx: RequestContext<TEnv>;
  request: Request;
  url: URL;
  variables: Record<string, unknown>;
}

/**
 * Create a real RequestContext for unit-testing loaders/middleware.
 *
 * The returned `ctx` must be ENTERED before use — wrap your call in
 * `runWithRequestContext(ctx, fn)` (re-exported from `@rangojs/router/testing`)
 * so that cookie/header mutations and `getRequestContext()` resolve. For the
 * common case prefer {@link runInRequestContext}, which builds AND enters the
 * context in a single call.
 */
export function createTestRequestContext<TEnv>(
  opts: CreateTestContextOptions<TEnv> = {},
): TestRequestContext<TEnv> {
  const request = toRequest(opts.request, opts.requestInit);
  const url = new URL(request.url);
  const variables = seedVariables(opts.variables ?? {}, opts.vars);
  const ctx = createRequestContext<TEnv>({
    env: (opts.env ?? {}) as TEnv,
    request,
    url,
    variables,
    themeConfig:
      opts.theme === undefined ? undefined : resolveThemeConfig(opts.theme),
    cacheStore: opts.cacheStore,
    cacheProfiles: opts.cacheProfiles,
  });
  if (opts.basename !== undefined)
    ctx._basename = normalizeBasename(opts.basename);
  if (opts.params) ctx.params = opts.params;
  if (opts.routeMap) {
    ctx._routeName = opts.routeName;
    ctx.reverse = createReverseFunction(
      opts.routeMap,
      opts.routeName,
      opts.params ?? {},
    ) as RequestContext<TEnv>["reverse"];
  }
  return { ctx, request, url, variables };
}

/**
 * Build a seeded RequestContext (via {@link createTestRequestContext}) and run
 * `fn` inside it, so code under test that calls `getRequestContext()`,
 * `cookies()`, or reads/mutates request headers resolves exactly as in
 * production.
 *
 * This is the entry point for the advanced cases the unit wrappers
 * (`runLoader` / `runMiddleware`) do not model — most notably a server ACTION
 * that authenticates off the request cookie: an action has no loader context, so
 * `runLoader` is the wrong shape, yet it still needs a real request context to
 * read the cookie and resolve `getRequestContext()`.
 *
 * `fn` receives the same `RequestContext` `createTestRequestContext` returns; its
 * return value is passed straight through — a returned promise keeps the context
 * active across awaits because it runs inside AsyncLocalStorage.
 *
 * @example
 * ```ts
 * const session = await runInRequestContext(
 *   () => authorizeTenantAction(input),
 *   {
 *     env,
 *     request: new Request("https://app.test/", {
 *       headers: { Cookie: "sid=abc" },
 *     }),
 *   },
 * );
 * ```
 */
export function runInRequestContext<T, TEnv = unknown>(
  fn: (ctx: RequestContext<TEnv>) => T,
  opts: CreateTestContextOptions<TEnv> = {},
): T {
  const { ctx } = createTestRequestContext<TEnv>(opts);
  return runWithRequestContext(ctx, () => fn(ctx));
}
