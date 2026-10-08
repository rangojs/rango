"use client";

import type { TransitionWhenContext } from "@rangojs/router";

/**
 * /sc/when/:n: only a push to a destination other than n=b is held. A push to
 * b, an action refetch and a refresh are gated off, so they commit urgently.
 */
export function scWhen(ctx: TransitionWhenContext): boolean {
  return ctx.kind === "push" && ctx.to.params.n !== "b";
}
