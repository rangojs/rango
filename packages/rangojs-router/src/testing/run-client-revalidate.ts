/**
 * runClientRevalidate — unit-test clientUrls() revalidate() predicates.
 *
 * Builds the same {@link ClientRevalidateArgs} the browser collector passes
 * and evaluates the predicate(s) through the SAME chain evaluator production
 * uses (client-urls/revalidate-chain.ts) — locked default, boolean
 * short-circuit, soft-verdict threading, and fail-open are the production
 * code paths, not a re-implementation. Pass an array to test a chain.
 *
 * Synchronous: client revalidate functions must be sync.
 */

import { makeIsAction } from "../router/is-action.js";
import { resolveTestActionId } from "./internal/action-id.js";
import {
  lockedClientDefault,
  runClientRevalidateChain,
} from "../client-urls/revalidate-chain.js";
import { toURL } from "./to-url.js";
import type {
  ClientRevalidateArgs,
  ClientRevalidateFn,
} from "../client-urls/types.js";

const DEFAULT_URL = "http://localhost/";

/**
 * Options for {@link runClientRevalidate}. Defaults model a same-URL
 * navigation with no action (locked default `false`).
 */
export interface RunClientRevalidateOptions {
  currentUrl?: string | URL;
  nextUrl?: string | URL;
  currentParams?: Record<string, string>;
  nextParams?: Record<string, string>;
  stale?: boolean;
  /**
   * The triggering action: a single imported reference (id resolved via
   * `$id ?? $$id`; throws if the function carries neither) or a raw actionId
   * string. A namespace/object is rejected — it cannot identify the ONE
   * action that triggered the request. Omit for a plain navigation.
   */
  action?: ((...args: never[]) => unknown) | string;
  /**
   * Model an action-triggered refetch GET: predicates see `isAction()` as
   * true, but the locked default stays the navigation default, matching how
   * the server evaluates that request (no actionContext). Defaults to
   * treating a provided `action` as the action POST itself.
   */
  actionRequest?: boolean;
}

/**
 * Run one clientUrls `revalidate()` predicate — or a chain, in declaration
 * order — against production-built args. Returns the final boolean decision
 * (locked default if every predicate defers or throws).
 */
export function runClientRevalidate(
  fn: ClientRevalidateFn | readonly ClientRevalidateFn[],
  opts: RunClientRevalidateOptions = {},
): boolean {
  const currentUrl = toURL(opts.currentUrl, new URL(DEFAULT_URL));
  const nextUrl = toURL(opts.nextUrl, currentUrl);
  const currentParams = opts.currentParams ?? {};
  const nextParams = opts.nextParams ?? currentParams;
  const inAction = opts.action !== undefined;
  const actionId = resolveTestActionId(opts.action, "runClientRevalidate");
  const defaultShouldRevalidate = lockedClientDefault({
    actionRequest: opts.actionRequest ?? inAction,
    currentParams,
    nextParams,
    currentUrl,
    nextUrl,
  });

  const baseArgs: Omit<ClientRevalidateArgs, "defaultShouldRevalidate"> = {
    currentUrl,
    nextUrl,
    currentParams,
    nextParams,
    stale: opts.stale ?? false,
    isAction: makeIsAction(actionId, inAction),
    ...(actionId !== undefined ? { actionId } : {}),
  };

  return runClientRevalidateChain(
    Array.isArray(fn) ? fn : [fn],
    baseArgs,
    defaultShouldRevalidate,
    "runClientRevalidate predicate",
  );
}
