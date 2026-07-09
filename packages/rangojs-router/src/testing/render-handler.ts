/// <reference path="./flight-runtime.d.ts" />
/**
 * renderHandler — run a REAL route handler and assert what it renders.
 *
 * A Rango route handler is a pure function `(ctx) => RSC` (what you pass to
 * `path("/p/:slug", ProductPage)`), NOT a component. To test one faithfully you
 * must give it the HandlerContext the router builds at runtime, so `ctx.params`,
 * `ctx.use(Loader)`, `ctx.use(Meta)` / `ctx.use(Breadcrumbs)` (handles),
 * `ctx.reverse`, `ctx.get`/`ctx.header`/`cookies()` all work. renderHandler does
 * exactly that, then serializes the handler's returned RSC and deserializes it
 * to an inspectable tree (same serialize/deserialize core as renderServerTree).
 *
 * Loaders are SEEDED (no real loader execution) the same way `runLoader` seeds
 * them — pass `loaders: [[ProductLoader, data]]`. Handle pushes
 * (`ctx.use(Meta)({...})`) are captured on `result.handles`. The handler's
 * cookie/header/flash effects and a thrown/returned redirect are surfaced too
 * (like `runInRequestContext`). If the handler returns/throws a `Response`
 * (a response route / `throw redirect()`), there is no RSC `tree`.
 *
 * Must run under the `react-server` export condition (the rsc Vitest project).
 * Wire `rangoUseClientTransform()` so `"use client"` islands in the handler's RSC
 * auto-register (or pass `clientComponents`).
 */
import type { ReactNode } from "react";
import {
  createRequestContext,
  runWithRequestContext,
  setRequestContextParams,
  type RequestContext,
} from "../server/request-context.js";
import { createHandlerContext } from "../router/handler-context.js";
import { resolveLocationStateEntries } from "../browser/react/location-state-shared.js";
import { isHandle, type Handle } from "../handle.js";
import { withDefer } from "../defer.js";
import type { HandlerContext } from "../types/handler-context.js";
import type { LoaderDefinition } from "../types.js";
import {
  seedVariables,
  resolveSeededStateCookieName,
  type VarsInit,
  type StateCookieSeed,
} from "./internal/seed-vars.js";

export type { StateCookieSeed } from "./internal/seed-vars.js";
import {
  assertNoLegacyUrlOption,
  serializeNodeToFlight,
  isServerOnlyStubError,
} from "./flight.js";
import type { SegmentCacheStore } from "../cache/types.js";
import type { CacheProfile } from "../cache/profile-registry.js";
import type { ThemeConfig } from "../theme/types.js";
import { resolveThemeConfig } from "../theme/constants.js";
import {
  deserializeFlight,
  makeClientManifest,
  registerClientComponents,
} from "./flight-tree.js";

const DEFAULT_URL = "http://localhost/";

/** A route handler under test: the `(ctx) => RSC | Response` function you pass to `path(...)`. */
export type TestableHandler<TEnv = any> = (
  ctx: HandlerContext<any, TEnv>,
) => ReactNode | Response | Promise<ReactNode | Response>;

/** Options for {@link renderHandler}. */
export interface RenderHandlerOptions<TEnv = any> {
  /** Route params surfaced as `ctx.params`. */
  params?: Record<string, string>;
  /** Environment bindings surfaced as `ctx.env`. */
  env?: TEnv;
  /** Backing Request (string or Request); defaults to a localhost GET. */
  request?: Request | string;
  /** Request headers (e.g. Cookie) the handler reads via `cookies()`. */
  headers?: HeadersInit;
  /** Variables a prior middleware set, read via `ctx.get(...)`. Object or tuples. */
  vars?: VarsInit;
  /** Matched route name (drives `ctx.routeName` and scoped reverse). */
  routeName?: string;
  /** Route name -> pattern map enabling `ctx.reverse()`. */
  routeMap?: Record<string, string>;
  /**
   * Seed `ctx.build` (default false) so a handler that branches on the
   * build-time pass — including calling `ctx.dynamic()` on a MISS — is
   * unit-testable. Assert a `ctx.dynamic()` call via `result.dynamic`.
   */
  build?: boolean;
  /**
   * Seed the data `ctx.use(SomeLoader)` returns — NO real loader runs (same model
   * as `runLoader`'s `loaders`). Matched by loader reference, so a real
   * `createLoader()` handle resolves regardless of its build-injected `$$id`.
   */
  loaders?: ReadonlyArray<readonly [LoaderDefinition<any, any>, unknown]>;
  /**
   * `"use client"` components in the handler's RSC, so they serialize as real
   * boundaries when `rangoUseClientTransform()` is not wired. Keyed by name; see
   * renderServerTree's `clientComponents`.
   */
  clientComponents?: Record<string, unknown>;
  /**
   * Customize the rango state cookie a handler that calls
   * `invalidateClientCache()` rotates. The name is ALWAYS seeded (default
   * `rango-state_router_0`) so the rotation `Set-Cookie` is emitted like
   * production rather than no-opping; override `prefix`/`routerId` to match your
   * `createRouter({ stateCookiePrefix, id })`, or `version` (the build
   * identifier prefixed to the rotated `{version}:{timestamp}` value, default
   * `"0"`). Assert via `result.response.headers.getSetCookie()` against
   * `result.stateCookieName`.
   */
  stateCookie?: StateCookieSeed;
  /**
   * Segment cache store backing a `"use cache"` function the handler invokes
   * (e.g. `new MemorySegmentCacheStore()`). Without it, `registerCachedFunction`
   * takes the uncached bypass and the cached path is NOT exercised (the runtime
   * emits a one-time warning under the test runner). Pair with `cacheProfiles`
   * so the profile the directive names resolves.
   */
  cacheStore?: SegmentCacheStore;
  /**
   * Cache profiles in the `createRouter({ cacheProfiles })` shape, required for
   * `"use cache: profileName"` resolution once a `cacheStore` is wired.
   */
  cacheProfiles?: Record<string, CacheProfile>;
  /**
   * Render as if inside a server action's revalidation render (production sets
   * this in revalidateAfterAction). A stale `"use cache"` entry whose profile
   * opts into `foregroundOnAction` then re-executes in the FOREGROUND (fresh
   * result in this render) instead of being served stale + revalidated in the
   * background. Without it, a stale entry keeps SWR. Pair with `cacheStore` +
   * `cacheProfiles` to exercise the `foregroundOnAction` opt-in.
   */
  inActionRevalidation?: boolean;
  /**
   * Theme config in the same shape `createRouter({ theme })` takes (e.g. `true`
   * or `{ themes: [...] }`). Without it `ctx.theme`/`ctx.setTheme` are inert,
   * mirroring an app with no theme configured. Pass one to exercise a handler
   * that reads `ctx.theme` or writes the theme cookie via `ctx.setTheme(...)`.
   */
  theme?: ThemeConfig | true;
}

/** Result of {@link renderHandler}. */
export interface RenderHandlerResult {
  /**
   * The deserialized RSC the handler returned, as an inspectable React element
   * tree — `undefined` when the handler returned or threw a `Response`. Use
   * `findClientBoundaries` (from testing/flight) to locate client islands.
   */
  tree: unknown;
  /** The raw Flight wire string; `undefined` when the handler produced a `Response`. */
  flight: string | undefined;
  /** The value the handler THREW (a `redirect()`/`notFound()` Response), captured not re-thrown. */
  thrown: unknown;
  /** The merged Response (status + headers + Set-Cookie); a thrown/returned redirect merged with accumulated effects. */
  response: Response;
  /** Effective cookie view after the handler ran, as `{ name: value }`. */
  cookies: Record<string, string>;
  /** Response headers as `{ name: value }` (excludes set-cookie; includes a redirect Location). */
  headers: Record<string, string>;
  /**
   * The resolved rango state cookie name this run seeded (default
   * `rango-state_router_0`, or composed from `opts.stateCookie`). Assert the
   * `invalidateClientCache()` rotation against it without recomputing:
   * `response.headers.getSetCookie().some((c) => c.startsWith(stateCookieName + "="))`.
   */
  stateCookieName: string;
  /** Location state the handler set (`ctx.setLocationState`/`redirect({ state })`), as `{ key: value }`. */
  locationState: Record<string, unknown>;
  /** What the handler pushed via `ctx.use(Handle)(...)` (e.g. Meta, Breadcrumbs), keyed by handle. */
  handles: Map<Handle<any, any>, unknown[]>;
  /**
   * Whether the handler called `ctx.dynamic()` (the PPR shell opt-out). The
   * public way to assert the opt-out without reading the `@internal`
   * `ctx._dynamic`.
   */
  dynamic: boolean;
}

/**
 * A renderHandler MISCONFIGURATION (e.g. an unseeded loader) — distinct from a
 * value the handler intentionally threw (a redirect). Setup errors REJECT;
 * handler throws are captured on `result.thrown`.
 */
class RenderHandlerSetupError extends Error {}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") out[name] = value;
  });
  return out;
}

function toRequest(
  request: Request | string | undefined,
  headers?: HeadersInit,
): Request {
  if (request instanceof Request) return request;
  if (typeof request === "string") {
    return new Request(new URL(request, DEFAULT_URL), { headers });
  }
  return new Request(DEFAULT_URL, { headers });
}

function buildResponse(reqCtx: RequestContext<any>, source: unknown): Response {
  const stub = reqCtx.res;
  if (source instanceof Response) {
    const merged = new Headers(source.headers);
    for (const cookie of stub.headers.getSetCookie()) {
      merged.append("set-cookie", cookie);
    }
    stub.headers.forEach((value, name) => {
      if (name.toLowerCase() === "set-cookie") return;
      if (!merged.has(name)) merged.set(name, value);
    });
    return new Response(source.body, {
      status: source.status,
      headers: merged,
    });
  }
  return new Response(null, { status: stub.status, headers: stub.headers });
}

/**
 * Run a route handler with a seeded HandlerContext and return its rendered RSC
 * (deserialized tree) plus the effects it produced. See the module header.
 *
 * @example
 * ```ts
 * // ProductPage is the real handler: (ctx) => <main>{ctx.params.slug}...</main>
 * const { tree, handles } = await renderHandler(ProductPage, {
 *   params: { slug: "wine" },
 *   loaders: [[ProductLoader, { name: "Wine", price: 9 }]],
 *   vars: [[Tenant, tenant]],
 *   routeMap: { product: "/p/:slug" },
 * });
 * ```
 */
export async function renderHandler<TEnv = any>(
  handler: TestableHandler<TEnv>,
  opts: RenderHandlerOptions<TEnv> = {},
): Promise<RenderHandlerResult> {
  assertNoLegacyUrlOption(opts, "renderHandler");
  if (opts.clientComponents) registerClientComponents(opts.clientComponents);
  const request = toRequest(opts.request, opts.headers);
  const url = new URL(request.url);
  const stateCookieName = resolveSeededStateCookieName(opts.stateCookie);
  const reqCtx = createRequestContext<TEnv>({
    env: (opts.env ?? {}) as TEnv,
    request,
    url,
    variables: seedVariables({}, opts.vars),
    build: opts.build,
    stateCookieName,
    version: opts.stateCookie?.version,
    cacheStore: opts.cacheStore,
    cacheProfiles: opts.cacheProfiles,
    themeConfig:
      opts.theme === undefined ? undefined : resolveThemeConfig(opts.theme),
  });

  // Simulate an action revalidation render (production sets this in
  // revalidateAfterAction) so a `foregroundOnAction` cache profile foregrounds a
  // stale entry. See the foregroundOnAction option doc.
  if (opts.inActionRevalidation) reqCtx._inActionRevalidation = true;

  const loaderSeeds = new Map<unknown, unknown>(opts.loaders ?? []);
  const handlePushes = new Map<Handle<any, any>, unknown[]>();

  let out: ReactNode | Response | undefined;
  let flight: string | undefined;
  let thrown: unknown;
  let didThrow = false;

  await runWithRequestContext(reqCtx as RequestContext<TEnv>, async () => {
    // Scope the request-context reverse to opts.routeMap too (not just the
    // handler context built below), so a nested server component reading
    // getRequestContext().reverse() resolves against the same map as the
    // handler's ctx.reverse -- matching renderToFlightString/renderServerTree.
    setRequestContextParams(opts.params ?? {}, opts.routeName, opts.routeMap);
    const hctx = createHandlerContext<TEnv>(
      opts.params ?? {},
      reqCtx.request,
      reqCtx.searchParams,
      reqCtx.pathname,
      reqCtx.url,
      reqCtx.env,
      opts.routeMap ?? {},
      opts.routeName,
    );
    (hctx as { use: unknown }).use = (item: unknown) => {
      if (isHandle(item)) {
        const handle = item as Handle<any, any>;
        // withDefer attaches .defer() so the harness mirrors production's push.
        return withDefer((dataOrFn: unknown) => {
          const value =
            typeof dataOrFn === "function"
              ? (dataOrFn as () => unknown)()
              : dataOrFn;
          const pushed = handlePushes.get(handle) ?? [];
          pushed.push(value);
          handlePushes.set(handle, pushed);
        });
      }
      // Production ctx.use(Loader) ALWAYS returns a Promise (the cached loader
      // promise); wrap the seed so a handler composing on the result matches.
      if (loaderSeeds.has(item)) return Promise.resolve(loaderSeeds.get(item));
      throw new RenderHandlerSetupError(
        `renderHandler: ctx.use(loader) was not seeded. Pass ` +
          `{ loaders: [[YourLoader, data]] } for each loader the handler reads.`,
      );
    };
    (hctx as { _currentSegmentId?: string })._currentSegmentId = "test.segment";

    try {
      out = await handler(hctx as HandlerContext<any, TEnv>);
      if (out !== undefined && !(out instanceof Response)) {
        flight = await serializeNodeToFlight(
          out as ReactNode,
          makeClientManifest(),
          url.pathname,
        );
      }
    } catch (error) {
      if (error instanceof RenderHandlerSetupError) throw error;
      if (isServerOnlyStubError(error)) {
        throw new RenderHandlerSetupError(
          `renderHandler: the handler called a server-only API (getRequestContext/cookies/...) ` +
            `but "@rangojs/router" resolved to the out-of-react-server stub. Add ` +
            `rangoTestAliases({ preset }) to your vitest.rsc.config.ts \`resolve.alias\` so the ` +
            `bare specifier maps to index.rsc.ts (the real react-server implementations). ` +
            `Original: ${(error as Error).message}`,
        );
      }
      didThrow = true;
      thrown = error;
    }
  });

  const cookies = { ...reqCtx.cookies() };
  const responseSource = didThrow
    ? thrown
    : out instanceof Response
      ? out
      : undefined;
  const response = buildResponse(reqCtx as RequestContext<any>, responseSource);
  const headers = headersToObject(response.headers);
  const locationState = resolveLocationStateEntries(
    (
      reqCtx as {
        _locationState?: Parameters<typeof resolveLocationStateEntries>[0];
      }
    )._locationState ?? [],
  );
  const tree =
    flight !== undefined ? await deserializeFlight(flight) : undefined;

  return {
    tree,
    flight,
    thrown,
    response,
    cookies,
    headers,
    stateCookieName,
    locationState,
    handles: handlePushes,
    dynamic: (reqCtx as RequestContext<TEnv>)._dynamic === true,
  };
}
