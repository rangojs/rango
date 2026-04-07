import {
  classifyActionResponse,
  type ActionScenario,
} from "./action-response-classifier.js";
import type { ActionEntry } from "./event-controller.js";

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

/**
 * Compute consolidation segments from concurrent action state.
 *
 * Returns segment IDs that need re-fetching when concurrent actions
 * have each revalidated different parts of the tree, or null if
 * consolidation is not needed.
 */
function computeConsolidationSegments(
  input: ActionOutcomeInput,
): string[] | null {
  if (!input.hadAnyConcurrentActions) return null;
  if (input.revalidatedSegments.size === 0) return null;

  // Can't consolidate while any action is still waiting for a server response
  const stillFetchingCount = [...input.inflightActions.values()].filter(
    (a) => a.phase === "fetching",
  ).length;
  if (stillFetchingCount > 0) return null;

  return Array.from(input.revalidatedSegments);
}

/**
 * Count other actions still in "fetching" phase (excluding this handle).
 */
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
 * Classify a post-reconciliation action outcome into one of 5 scenarios.
 *
 * This is the single entry point for post-action decision logic.
 * It gathers consolidation and concurrency data from the plain inputs,
 * then delegates to the pure classifyActionResponse function.
 *
 * The server-action-bridge calls this after reconciliation to decide
 * whether to render, skip, consolidate, or refetch.
 */
export function classifyActionOutcome(
  input: ActionOutcomeInput,
): ActionScenario {
  return classifyActionResponse({
    actionStartPathname: input.actionStartPathname,
    currentPathname: input.currentPathname,
    actionStartLocationKey: input.actionStartLocationKey,
    currentLocationKey: input.currentLocationKey,
    reconciledSegmentCount: input.reconciledSegmentCount,
    matchedCount: input.matchedCount,
    currentInterceptSource: input.currentInterceptSource,
    consolidationSegments: computeConsolidationSegments(input),
    otherFetchingActionCount: countOtherFetchingActions(input),
  });
}

export type { ActionScenario };
