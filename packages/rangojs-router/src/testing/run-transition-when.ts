/**
 * runTransitionWhen — unit-test a transition({ when }) predicate in isolation.
 *
 * Runs the SAME server functions the router uses — the PPR pre-handler evaluator
 * when `ppr: true`, applyViewTransitionDefault (which strips the server-only
 * function), and gateTransitions. So the
 * predicate sees exactly the navigation/action metadata it would at runtime
 * (currentUrl/currentParams/fromRouteName, nextUrl/nextParams/toRouteName,
 * actionId/actionUrl/actionResult/formData/method, get/env), and `kept` reflects
 * whether the transition would apply this request. The result also exposes the
 * assembled `whenContext` so tests can assert the exact fields without reaching
 * into private request-context state.
 *
 * This is the public way to exercise a transition gate: the full
 * match -> render pipeline that wires these together only runs under real RSC
 * rendering (which the Flight primitives do not drive), so without this primitive
 * a consumer could not test their predicate through @rangojs/router/testing.
 *
 * Synchronous: a transition predicate returns a boolean and the gate has no I/O.
 */

import {
  runWithRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import { applyViewTransitionDefault } from "../router/segment-resolution/view-transition-default.js";
import { gateTransitions } from "../rsc/transition-gate.js";
import { createTestRequestContext, type VarsInit } from "./internal/context.js";
import type {
  ResolvedSegment,
  TransitionConfig,
  TransitionWhenContext,
} from "../types/segments.js";
import type { OnErrorCallback } from "../types/error-types.js";
import type { EntryData } from "../server/context.js";
import { evaluatePprTransitionWhen } from "../router/transition-when.js";
import { invokeOnError } from "../router/error-handling.js";
import { toURL } from "./to-url.js";

/**
 * Options for runTransitionWhen. All navigation/action fields are optional and
 * default to "absent", matching what the gate sees for an initial full load with
 * no action: omit `currentUrl`/`currentParams`/`fromRouteName` to model the
 * navigation source being unavailable, and omit the `action*` fields to model a
 * plain (non-action) navigation.
 */
export interface RunTransitionWhenOptions<TEnv = any> {
  /** The navigation TARGET request (drives `nextUrl`): a Request or URL/path string. Defaults to `http://localhost/`. */
  request?: Request | string;
  /** Route params for the target (`nextParams`). */
  params?: Record<string, string>;
  /** Target route name (`toRouteName`). */
  toRouteName?: string;
  /** Environment bindings surfaced as `env` (and `ctx.env`). */
  env?: TEnv;
  /** Variables readable via the predicate's `get()`. With `ppr`, these model pre-handler middleware/input state. */
  vars?: VarsInit;
  /** Navigation SOURCE url (`currentUrl`): a URL or path string. */
  currentUrl?: string | URL;
  /** Source route params (`currentParams`). */
  currentParams?: Record<string, string>;
  /** Source route name (`fromRouteName`). */
  fromRouteName?: string;
  /** Id of the action that triggered a revalidation (`actionId`). */
  actionId?: string;
  /** Url the action was submitted from (`actionUrl`). */
  actionUrl?: string | URL;
  /** The action's return value (`actionResult`). */
  actionResult?: unknown;
  /** FormData from a form action (`formData`). */
  formData?: FormData;
  /** Receives an error thrown by the predicate (the gate reports to `router.onError`, phase `"rendering"`). */
  onError?: OnErrorCallback;
  /** Model a route with `ppr`, where the predicate runs before route handlers and cache lookup. */
  ppr?: boolean;
}

/**
 * Result of runTransitionWhen.
 */
export interface RunTransitionWhenResult<TEnv = any> {
  /** True if the transition would apply this request (predicate returned non-false, or there is no `when`). */
  kept: boolean;
  /** Convenience inverse of `kept`. */
  dropped: boolean;
  /**
   * The production-assembled predicate context. Undefined when the config has
   * no `when` predicate.
   */
  whenContext?: TransitionWhenContext<Record<string, string>, TEnv>;
  /** The underlying RequestContext, for additional assertions (`ctx.get(...)`, etc.). */
  ctx: RequestContext<TEnv>;
}

export function runTransitionWhen<TEnv = any>(
  config: TransitionConfig,
  opts: RunTransitionWhenOptions<TEnv> = {},
): RunTransitionWhenResult<TEnv> {
  const { ctx } = createTestRequestContext<TEnv>({
    env: opts.env,
    request: opts.request,
    vars: opts.vars,
    params: opts.params,
  });
  const reqCtx = ctx as unknown as RequestContext<TEnv>;

  // Target route name (the public field the gate reads for `toRouteName`).
  if (opts.toRouteName !== undefined)
    reqCtx.routeName = opts.toRouteName as RequestContext<TEnv>["routeName"];
  // Source (match-time) data the gate reads for currentUrl/currentParams/fromRouteName.
  if (opts.currentUrl !== undefined)
    reqCtx._gateCurrentUrl = toURL(opts.currentUrl, reqCtx.url);
  if (opts.currentParams !== undefined)
    reqCtx._gateCurrentParams = opts.currentParams;
  if (opts.fromRouteName !== undefined)
    reqCtx._prevRouteKey = opts.fromRouteName;
  // Action data the gate reads at the action-bearing call sites.
  if (opts.actionId !== undefined) reqCtx._gateActionId = opts.actionId;
  if (opts.actionUrl !== undefined)
    reqCtx._gateActionUrl = toURL(opts.actionUrl, reqCtx.url);
  if (opts.actionResult !== undefined)
    reqCtx._gateActionResult = opts.actionResult;
  if (opts.formData !== undefined) reqCtx._gateFormData = opts.formData;

  let whenContext:
    | TransitionWhenContext<Record<string, string>, TEnv>
    | undefined;
  const when = config.when;
  const configForGate: TransitionConfig = when
    ? {
        ...config,
        when: (c) => {
          whenContext = c as TransitionWhenContext<
            Record<string, string>,
            TEnv
          >;
          return when(c);
        },
      }
    : config;

  return runWithRequestContext(reqCtx, () => {
    if (opts.ppr) {
      const entry = {
        type: "route",
        id: "tx-when-entry",
        shortCode: "tx-when-seg",
        parent: null,
        transition: configForGate,
        layout: [],
        parallel: {},
      } as unknown as EntryData;
      evaluatePprTransitionWhen(
        [entry],
        reqCtx,
        { params: reqCtx.params, routeName: opts.toRouteName },
        (error, segmentId) =>
          invokeOnError(
            opts.onError,
            error,
            "rendering",
            {
              request: reqCtx.request,
              url: reqCtx.url,
              params: reqCtx.params,
              segmentId,
            },
            "RSC",
          ),
      );
    }
    // Ordinary predicates are collected here and evaluated by the gate. PPR
    // predicates keep the decision already evaluated before this step.
    const serialized = applyViewTransitionDefault(
      configForGate,
      undefined,
      "tx-when-seg",
    );
    const segment = {
      id: "tx-when-seg",
      namespace: "r",
      type: "route",
      index: 0,
      component: null,
      transition: serialized,
    } as ResolvedSegment;
    const [gatedSegment] = gateTransitions(
      [segment],
      reqCtx as Parameters<typeof gateTransitions>[1],
      opts.onError,
    );
    const kept = gatedSegment.transition !== undefined;
    return { kept, dropped: !kept, whenContext, ctx: reqCtx };
  });
}
