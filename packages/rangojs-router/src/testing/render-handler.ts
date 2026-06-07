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
import type { HandlerContext } from "../types/handler-context.js";
import type { LoaderDefinition } from "../types.js";
import { seedVariables, type VarsInit } from "./internal/seed-vars.js";
import { serializeNodeToFlight } from "./flight.js";
import {
  deserializeFlight,
  makeClientManifest,
  registerClientComponents,
} from "./flight-tree.js";

const DEFAULT_URL = "http://localhost/";

/** A route handler under test: the `(ctx) => RSC | Response` function you pass to `path(...)`. */
export type TestableHandler<TEnv = any> = (
  ctx: HandlerContext<any, TEnv>,
) => ReactNode | Promise<ReactNode> | Response | Promise<Response>;

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
  /** Location state the handler set (`ctx.setLocationState`/`redirect({ state })`), as `{ key: value }`. */
  locationState: Record<string, unknown>;
  /** What the handler pushed via `ctx.use(Handle)(...)` (e.g. Meta, Breadcrumbs), keyed by handle. */
  handles: Map<Handle<any, any>, unknown[]>;
}

/**
 * A renderHandler MISCONFIGURATION (e.g. an unseeded loader) — distinct from a
 * value the handler intentionally threw (a redirect). Setup errors REJECT;
 * handler throws are captured on `result.thrown`.
 */
class RenderHandlerSetupError extends Error {}

/**
 * Detect the server-only-API stub throw: when a handler/component imports
 * getRequestContext()/cookies()/etc. from the BARE `@rangojs/router` specifier
 * (the out-of-react-server stub in index.ts) instead of the react-server build.
 * In an rsc test this happens when the vitest.rsc.config.ts `resolve.alias` does
 * not map the bare specifier to `index.rsc.ts` (the `rangoTestAliases` preset).
 * The dual-substring match keeps a legitimate handler throw from being
 * reclassified as a setup error.
 */
function isServerOnlyStubError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("is only available from") &&
    error.message.includes("react-server")
  );
}

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

function buildResponse(reqCtx: RequestContext<any>, thrown: unknown): Response {
  const stub = reqCtx.res;
  if (thrown instanceof Response) {
    const merged = new Headers(thrown.headers);
    for (const cookie of stub.headers.getSetCookie()) {
      merged.append("set-cookie", cookie);
    }
    stub.headers.forEach((value, name) => {
      if (name.toLowerCase() === "set-cookie") return;
      if (!merged.has(name)) merged.set(name, value);
    });
    return new Response(null, { status: thrown.status, headers: merged });
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
  if (opts.clientComponents) registerClientComponents(opts.clientComponents);
  const request = toRequest(opts.request, opts.headers);
  const url = new URL(request.url);
  const reqCtx = createRequestContext<TEnv>({
    env: (opts.env ?? {}) as TEnv,
    request,
    url,
    variables: seedVariables({}, opts.vars),
  });

  const loaderSeeds = new Map<unknown, unknown>(opts.loaders ?? []);
  const handlePushes = new Map<Handle<any, any>, unknown[]>();

  let out: ReactNode | Response | undefined;
  let flight: string | undefined;
  let thrown: unknown;
  let didThrow = false;

  await runWithRequestContext(reqCtx as RequestContext<TEnv>, async () => {
    setRequestContextParams(opts.params ?? {}, opts.routeName);
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
    // Seed ctx.use: a handle returns a push fn that RECORDS (so ctx.use(Meta)
    // doesn't crash and pushes are assertable); a loader returns its seeded data
    // (no real loader run).
    (hctx as { use: unknown }).use = (item: unknown) => {
      if (isHandle(item)) {
        const handle = item as Handle<any, any>;
        return (value: unknown) => {
          const pushed = handlePushes.get(handle) ?? [];
          pushed.push(value);
          handlePushes.set(handle, pushed);
        };
      }
      if (loaderSeeds.has(item)) return loaderSeeds.get(item);
      throw new RenderHandlerSetupError(
        `renderHandler: ctx.use(loader) was not seeded. Pass ` +
          `{ loaders: [[YourLoader, data]] } for each loader the handler reads.`,
      );
    };
    (hctx as { _currentSegmentId?: string })._currentSegmentId = "test.segment";

    try {
      out = await handler(hctx as HandlerContext<any, TEnv>);
      // Serialize the RSC in THIS context, so nested async server components see
      // getRequestContext()/cookies()/vars while they render.
      if (out !== undefined && !(out instanceof Response)) {
        flight = await serializeNodeToFlight(
          out as ReactNode,
          makeClientManifest(),
          url.pathname,
        );
      }
    } catch (error) {
      // A harness misconfiguration (unseeded loader) is the consumer's mistake —
      // surface it as a rejection, not as a captured handler throw.
      if (error instanceof RenderHandlerSetupError) throw error;
      // Same for the server-only-API stub throw: the handler read
      // getRequestContext()/cookies() but the bare `@rangojs/router` resolved to
      // the throwing stub. Rethrow LOUDLY with the fix, instead of silently
      // capturing it (which surfaces as an opaque tree:undefined + bare throw).
      if (isServerOnlyStubError(error)) {
        throw new RenderHandlerSetupError(
          `renderHandler: the handler called a server-only API (getRequestContext/cookies/...) ` +
            `but "@rangojs/router" resolved to the out-of-react-server stub. Add ` +
            `rangoTestAliases({ preset }) to your vitest.rsc.config.ts \`resolve.alias\` so the ` +
            `bare specifier maps to index.rsc.ts (the real react-server implementations). ` +
            `Original: ${(error as Error).message}`,
        );
      }
      // Otherwise captured, NOT re-thrown: a handler's success path is often
      // `throw redirect(...)`; its cookies/flash must stay observable.
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
  // Deserialize outside the context (the client deserializer needs no ctx).
  const tree =
    flight !== undefined ? await deserializeFlight(flight) : undefined;

  return {
    tree,
    flight,
    thrown,
    response,
    cookies,
    headers,
    locationState,
    handles: handlePushes,
  };
}
