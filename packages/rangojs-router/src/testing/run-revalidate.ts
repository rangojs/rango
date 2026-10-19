/**
 * runRevalidate — unit-test revalidate() predicates: a urls() segment's, or a
 * clientUrls() loader's (which the build moves to the server, where it runs
 * the same way).
 *
 * Evaluates the predicate(s) through the router's own evaluateRevalidation
 * (router/revalidation.ts) inside a seeded request context: the default
 * decision, the argument object, boolean short-circuit, soft-verdict
 * threading and the fail-open on a throw are the production code paths, not
 * a re-implementation. Pass an array to test a chain in declaration order.
 */

import {
  evaluateRevalidation,
  toShouldRevalidateFn,
} from "../router/revalidation.js";
import { runWithRequestContext } from "../server/request-context.js";
import type { ResolvedSegment, ShouldRevalidateFn } from "../types.js";
import {
  normalizeTestAction,
  resolveTestActionId,
  type ImportedAction,
} from "./internal/action-id.js";
import { createTestRequestContext } from "./internal/context.js";
import type { VarsInit } from "./internal/seed-vars.js";
import { toURL } from "./to-url.js";

type RevalidateArgs = Parameters<ShouldRevalidateFn<any, any>>[0];

/** The action fields a predicate receives on an action request. */
export interface RunRevalidateAction {
  /** The triggering action: an imported server action or its actionId. */
  ref?: ImportedAction | string;
  /** `actionResult`: the action's return value. */
  result?: unknown;
  /** `formData`: the action's FormData argument. */
  formData?: FormData;
  /** `actionUrl`. Defaults to `currentUrl`. */
  url?: string | URL;
}

/**
 * Options for {@link runRevalidate}. Defaults model a same-URL navigation
 * with no action, for a route-owned loader segment.
 */
export interface RunRevalidateOptions<TEnv = any> {
  /** The page being left. Defaults to `http://localhost/`. */
  currentUrl?: string | URL;
  /** The destination. Defaults to `currentUrl`. */
  nextUrl?: string | URL;
  currentParams?: Record<string, string>;
  /** Defaults to `currentParams`. */
  nextParams?: Record<string, string>;
  /**
   * The triggering action: an imported server action (id via
   * `$id ?? $$id`), an actionId string, or `{ ref, result, formData, url }`.
   * Makes the request a POST, as an action request is.
   */
  action?: ImportedAction | string | RunRevalidateAction;
  /** Overrides the request method (`POST` with `action`, else `GET`). */
  method?: string;
  /** The segment the predicate is attached to. Defaults to `"loader"`. */
  segmentType?: RevalidateArgs["segmentType"];
  /**
   * The segment belongs to the matched route (a route's own loaders, a
   * clientUrls() group loader). Defaults to true; false models a layout's
   * loader, which a navigation keeps by default.
   */
  belongsToRoute?: boolean;
  /**
   * `stale`: a navigation sent during a server action's flight, or a history
   * entry's background revalidation.
   */
  stale?: boolean;
  /** `toRouteName` (and `routeName`). */
  routeName?: string;
  /** `fromRouteName`. */
  fromRouteName?: string;
  /** Environment bindings of the seeded context. */
  env?: TEnv;
  /** Variables a middleware would have set, readable with `context.get()`. */
  vars?: VarsInit;
  /** `context`, in place of the seeded request context. */
  context?: RevalidateArgs["context"];
}

const DEFAULT_URL = "http://localhost/";

/**
 * Run one revalidate() argument, or a chain in declaration order, the way
 * the router does for a request: a predicate, or `true` / `false` as
 * `revalidate()` takes them. Resolves to the final decision: true re-runs
 * the segment, false keeps the client's copy.
 */
export async function runRevalidate<TEnv = any>(
  fn:
    | ShouldRevalidateFn<any, TEnv>
    | boolean
    | readonly (ShouldRevalidateFn<any, TEnv> | boolean)[],
  opts: RunRevalidateOptions<TEnv> = {},
): Promise<boolean> {
  const currentUrl = toURL(opts.currentUrl, new URL(DEFAULT_URL));
  const nextUrl = toURL(opts.nextUrl, currentUrl);
  const currentParams = opts.currentParams ?? {};
  const nextParams = opts.nextParams ?? currentParams;
  const action = normalizeTestAction(opts.action);
  const method = opts.method ?? (action ? "POST" : "GET");
  const request = new Request(nextUrl, { method });
  const { ctx } = createTestRequestContext<TEnv>({
    env: opts.env,
    request,
    vars: opts.vars,
    params: nextParams,
  });
  if (opts.fromRouteName !== undefined) ctx._prevRouteKey = opts.fromRouteName;

  const segment: ResolvedSegment = {
    id: "runRevalidate",
    namespace: "runRevalidate",
    type: opts.segmentType ?? "loader",
    index: 0,
    component: null,
    params: nextParams,
    belongsToRoute: opts.belongsToRoute ?? true,
  };
  const fns = Array.isArray(fn) ? fn : [fn];
  return runWithRequestContext(ctx as never, () =>
    evaluateRevalidation({
      segment,
      prevParams: currentParams,
      getPrevSegment: null,
      request,
      prevUrl: currentUrl,
      nextUrl,
      revalidations: fns.map((entry, index) => ({
        name: `runRevalidate#${index}`,
        fn: toShouldRevalidateFn(entry),
      })),
      routeKey: opts.routeName ?? "",
      context: (opts.context ?? ctx) as RevalidateArgs["context"],
      actionContext: action
        ? {
            actionId: resolveTestActionId(action.ref, "runRevalidate") ?? "",
            actionUrl: toURL(action.url, currentUrl),
            actionResult: action.result,
            formData: action.formData,
          }
        : undefined,
      stale: opts.stale ?? false,
    }),
  );
}
