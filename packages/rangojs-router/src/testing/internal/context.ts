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
  type RequestContext,
} from "../../server/request-context.js";
import { createReverseFunction } from "../../router/handler-context.js";
import { contextSet, type ContextVar } from "../../context-var.js";

const DEFAULT_ORIGIN = "http://localhost/";

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
  vars?: Iterable<readonly [ContextVar<unknown> | string, unknown]>,
): Record<string, unknown> {
  if (vars) {
    for (const [key, value] of vars) {
      contextSet(variables, key as ContextVar<unknown>, value);
    }
  }
  return variables;
}

export interface CreateTestContextOptions<TEnv> {
  env?: TEnv;
  request?: Request | string;
  requestInit?: RequestInit;
  /** Backing store for ctx.get()/ctx.set(); pre-seeded from `vars`. */
  variables?: Record<string, unknown>;
  /** Variables a prior middleware would have set, as [key, value] entries. */
  vars?: Iterable<readonly [ContextVar<unknown> | string, unknown]>;
  /** Route name -> pattern map enabling ctx.reverse() without global state. */
  routeMap?: Record<string, string>;
  routeName?: string;
  params?: Record<string, string>;
}

export interface TestRequestContext<TEnv> {
  ctx: RequestContext<TEnv>;
  request: Request;
  url: URL;
  variables: Record<string, unknown>;
}

/**
 * Create a real RequestContext for unit-testing loaders/middleware. The
 * returned ctx must be entered via runWithRequestContext() before use so that
 * cookie/header mutations and getRequestContext() resolve.
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
  });
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
