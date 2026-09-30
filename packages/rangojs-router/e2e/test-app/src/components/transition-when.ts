"use client";

import type { TransitionWhenContext } from "@rangojs/router";
import { TxWhenState } from "../location-states.js";

/**
 * transition({ when }) predicates for the test-app's server urls(). They run
 * in the browser at the navigation's first presentation; the server only
 * carries them as client references. Every call is logged to
 * window.__txWhenLog so e2e can assert what the predicate saw.
 */

export interface TxWhenLogEntry {
  readonly name: string;
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly sameLocation: boolean;
  readonly fromParams: Record<string, string>;
  readonly toParams: Record<string, string>;
  readonly fromRouteName: string | undefined;
  readonly toRouteName: string | undefined;
  readonly toAnimate: boolean | undefined;
  readonly isAction: boolean;
  readonly actionResult?: unknown;
  readonly actionError?: boolean;
  readonly actionFormData?: boolean;
  readonly result: boolean;
}

function log(
  name: string,
  ctx: TransitionWhenContext,
  result: boolean,
): boolean {
  if (typeof window !== "undefined") {
    const w = window as unknown as { __txWhenLog?: TxWhenLogEntry[] };
    (w.__txWhenLog ??= []).push({
      name,
      kind: ctx.kind,
      from: ctx.from.url.pathname + ctx.from.url.search,
      to: ctx.to.url.pathname + ctx.to.url.search,
      sameLocation: ctx.from === ctx.to,
      fromParams: { ...ctx.from.params },
      toParams: { ...ctx.to.params },
      fromRouteName: ctx.from.routeName,
      toRouteName: ctx.to.routeName,
      toAnimate: TxWhenState.read(ctx.to)?.animate,
      isAction: ctx.isAction(),
      ...(ctx.action
        ? {
            actionResult: ctx.action.result,
            actionError: ctx.action.error !== undefined,
            actionFormData: ctx.action.formData !== undefined,
          }
        : {}),
      result,
    });
  }
  return result;
}

/** /tx-when/:hold/:n — hold only when the destination's :hold param is "1". */
export function txHoldWhen(ctx: TransitionWhenContext): boolean {
  return log("txHold", ctx, ctx.to.params.hold === "1");
}

/**
 * /tx-src/:n — hold unless the location being left is n=b (the navigation
 * SOURCE), or the destination was pushed with TxWhenState { animate: false }.
 */
export function txSrcWhen(ctx: TransitionWhenContext): boolean {
  return log(
    "txSrc",
    ctx,
    ctx.from.params.n !== "b" && TxWhenState.read(ctx.to)?.animate !== false,
  );
}

/** /tx-keep layout (kept across sibling navigations): no hold into /tx-keep/b. */
export function txKeepWhen(ctx: TransitionWhenContext): boolean {
  return log("txKeep", ctx, ctx.to.url.pathname !== "/tx-keep/b");
}

/** /tx-act/:n layout: logs the action commits (success and error lanes). */
export function txActWhen(ctx: TransitionWhenContext): boolean {
  return log("txAct", ctx, true);
}

/** PPR exec-matrix: ?transition=drop on the destination gates it off. */
export function shellExecWhen(ctx: TransitionWhenContext): boolean {
  return log(
    "shellExec",
    ctx,
    ctx.to.url.searchParams.get("transition") !== "drop",
  );
}

/** Prerendered /docs/:slug: always holds; logs that it ran in the browser. */
export function docsWhen(ctx: TransitionWhenContext): boolean {
  return log("docs", ctx, true);
}

/** PPR load-more: hold only for same-path (paging) navigations. */
export function shellLoadMoreWhen(ctx: TransitionWhenContext): boolean {
  return log(
    "shellLoadMore",
    ctx,
    ctx.from.url.pathname === ctx.to.url.pathname,
  );
}
