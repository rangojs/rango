"use client";

import type { TransitionWhenContext } from "@rangojs/router";
import { PprExecMark, TxWhenState } from "../location-states.js";

/**
 * transition({ when }) predicates imported into server urls(). They run in
 * the browser at the navigation's first presentation; the server only
 * carries them as client references. Every call is logged to
 * window.__txWhenLog so e2e can assert what the predicate saw.
 */

export interface TxWhenLogEntry {
  readonly name: string;
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly fromParams: Record<string, string>;
  readonly toParams: Record<string, string>;
  readonly toRouteName: string | undefined;
  readonly toAnimate: boolean | undefined;
  readonly toMiddlewareMark: number | undefined;
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
      fromParams: { ...ctx.from.params },
      toParams: { ...ctx.to.params },
      toRouteName: ctx.to.routeName,
      toAnimate: TxWhenState.read(ctx.to)?.animate,
      toMiddlewareMark: PprExecMark.read(ctx.to)?.middleware,
      result,
    });
  }
  return result;
}

/**
 * /tx-src/:n: hold unless the location being left is n=b (the navigation
 * SOURCE), or the destination was pushed with TxWhenState { animate: false }.
 */
export function txSrcWhen(ctx: TransitionWhenContext): boolean {
  return log(
    "txSrc",
    ctx,
    ctx.from.params.n !== "b" && TxWhenState.read(ctx.to)?.animate !== false,
  );
}

/** /ppr-shell/exec-matrix: `?transition=drop` gates the navigation off. */
export function pprExecWhen(ctx: TransitionWhenContext): boolean {
  return log(
    "pprExec",
    ctx,
    ctx.to.url.searchParams.get("transition") !== "drop",
  );
}
