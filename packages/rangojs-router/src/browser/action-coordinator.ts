import type { ActionEntry } from "./event-controller.js";

/**
 * Post-reconciliation action outcome (discriminated union). Error and
 * full-update-unsupported cases are handled inline in the bridge before
 * reconciliation; this only covers successfully-reconciled partial responses.
 */
type ActionScenario =
  | {
      type: "navigated-away";
      historyKeyChanged: boolean;
      onInterceptRoute: boolean;
    }
  | { type: "hmr-missing" }
  | { type: "consolidation-needed"; segmentIds: string[] }
  | { type: "concurrent-skip"; otherFetchingCount: number }
  | { type: "normal" };

/**
 * Plain data inputs for classifying a post-reconciliation action outcome.
 * No browser objects or controller references — all values are snapshots.
 */
export interface ActionOutcomeInput {
  /** This action's unique instance ID */
  handleId: string;
  /** All in-flight action entries (snapshot from event controller) */
  inflightActions: Map<string, ActionEntry>;
  /** Whether any concurrent actions occurred (controller-level shared flag) */
  hadAnyConcurrentActions: boolean;
  /** Segments revalidated by concurrent actions (from tracking set) */
  revalidatedSegments: Set<string>;
  /** window.location.pathname captured at action start */
  actionStartPathname: string;
  /** window.location.pathname at classification time */
  currentPathname: string;
  /** window.history.state?.key captured at action start */
  actionStartLocationKey: string | undefined;
  /** window.history.state?.key at classification time */
  currentLocationKey: string | undefined;
  /** Number of segments after reconciliation */
  reconciledSegmentCount: number;
  /** Number of matched segment IDs from server */
  matchedCount: number;
  /** Current intercept source URL (null when not on intercept route) */
  currentInterceptSource: string | null;
}

// Segment IDs to re-fetch when concurrent actions each revalidated different
// parts of the tree; null when consolidation does not apply. Returns null while
// any action is still fetching — consolidation must wait for all to land.
function computeConsolidationSegments(
  input: ActionOutcomeInput,
): string[] | null {
  if (!input.hadAnyConcurrentActions) return null;
  if (input.revalidatedSegments.size === 0) return null;

  const stillFetchingCount = [...input.inflightActions.values()].filter(
    (a) => a.phase === "fetching",
  ).length;
  if (stillFetchingCount > 0) return null;

  return Array.from(input.revalidatedSegments);
}

function countOtherFetchingActions(input: ActionOutcomeInput): number {
  let count = 0;
  for (const [, a] of input.inflightActions) {
    if (a.phase === "fetching" && a.id !== input.handleId) {
      count++;
    }
  }
  return count;
}

/**
 * Classify a post-reconciliation action outcome. Ordered priority chain: each
 * case assumes the earlier ones are false (e.g. concurrent-skip only applies on
 * the still-current route, consolidation only once no action is still fetching).
 * The bridge calls this to decide whether to render, skip, consolidate, or refetch.
 */
export function classifyActionOutcome(
  input: ActionOutcomeInput,
): ActionScenario {
  if (
    input.currentPathname !== input.actionStartPathname ||
    input.currentLocationKey !== input.actionStartLocationKey
  ) {
    return {
      type: "navigated-away",
      historyKeyChanged:
        input.currentLocationKey !== input.actionStartLocationKey,
      onInterceptRoute: input.currentInterceptSource !== null,
    };
  }

  if (input.reconciledSegmentCount < input.matchedCount) {
    return { type: "hmr-missing" };
  }

  const consolidationSegments = computeConsolidationSegments(input);
  if (consolidationSegments && consolidationSegments.length > 0) {
    return { type: "consolidation-needed", segmentIds: consolidationSegments };
  }

  const otherFetchingActionCount = countOtherFetchingActions(input);
  if (otherFetchingActionCount > 0) {
    return {
      type: "concurrent-skip",
      otherFetchingCount: otherFetchingActionCount,
    };
  }

  return { type: "normal" };
}
