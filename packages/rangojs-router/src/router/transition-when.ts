import { getParallelSlotEntries, type EntryData } from "../server/context.js";
import type { RequestContext } from "../server/request-context.js";
import type { TransitionWhenContext } from "../types/segments.js";

export type TransitionWhenErrorReporter = (
  error: unknown,
  segmentId: string,
) => void;

export function createTransitionWhenContext<TEnv>(
  ctx: RequestContext<TEnv>,
  target?: {
    params: Record<string, string>;
    routeName?: string;
  },
): TransitionWhenContext<Record<string, string>, TEnv> {
  return {
    currentUrl: ctx._gateCurrentUrl,
    currentParams: ctx._gateCurrentParams,
    fromRouteName: ctx._prevRouteKey as TransitionWhenContext["fromRouteName"],
    nextUrl: ctx.url,
    nextParams: target?.params ?? ctx.params,
    toRouteName: (target?.routeName ??
      ctx.routeName) as TransitionWhenContext["toRouteName"],
    actionId: ctx._gateActionId,
    actionUrl: ctx._gateActionUrl,
    actionResult: ctx._gateActionResult,
    formData: ctx._gateFormData,
    method: ctx.request.method,
    get: ctx.get,
    env: ctx.env,
  };
}

/** Evaluate server-only transition gates before handlers on a PPR route. */
export function evaluatePprTransitionWhen<TEnv>(
  entries: EntryData[],
  ctx: RequestContext<TEnv>,
  target: {
    params: Record<string, string>;
    routeName?: string;
  },
  reportError: TransitionWhenErrorReporter,
): void {
  const decisions = new Map<string, boolean>();
  const whenContext = createTransitionWhenContext(ctx, target);
  const visited = new Set<EntryData>();

  const evaluate = (entry: EntryData, segmentId: string): void => {
    const when = entry.transition?.when;
    if (!when) return;
    try {
      decisions.set(segmentId, when(whenContext) !== false);
    } catch (error) {
      decisions.set(segmentId, false);
      reportError(error, segmentId);
    }
  };

  const visit = (entry: EntryData): void => {
    if (visited.has(entry)) return;
    visited.add(entry);
    evaluate(entry, entry.shortCode);

    for (const orphan of entry.layout) visit(orphan);
    for (const { slot, entry: parallelEntry } of getParallelSlotEntries(
      entry.parallel,
    )) {
      evaluate(parallelEntry, `${entry.shortCode}.${slot}`);
    }
  };

  for (const entry of entries) visit(entry);
  ctx._pprTransitionWhen = decisions.size > 0 ? decisions : undefined;
}
