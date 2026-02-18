/**
 * Discriminated union of post-reconciliation action response scenarios.
 *
 * Error and full-update-unsupported are handled inline in the bridge
 * before reconciliation. This classifier only runs for partial responses
 * that have been successfully reconciled.
 */
export type ActionScenario =
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
 * Pure data inputs for classifying a partial action response.
 * All values come from the bridge but no browser APIs or side effects.
 */
export interface ClassifierInput {
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
  /** Segment IDs needing consolidation (from concurrent action tracking) */
  consolidationSegments: string[] | null;
  /** Number of other actions still in "fetching" phase */
  otherFetchingActionCount: number;
  /** Current intercept source URL (null when not on intercept route) */
  currentInterceptSource: string | null;
}

/**
 * Classify a partial action response into one of 5 post-reconciliation
 * scenarios.
 *
 * Called after error and full-update cases are handled inline by the bridge.
 * The classification order matches the priority chain:
 * 1. User navigated away during action
 * 2. HMR missing segments (fewer reconciled than matched)
 * 3. Consolidation needed (concurrent actions finished)
 * 4. Concurrent skip (other actions still fetching)
 * 5. Normal (single action, no issues)
 *
 * This is a pure function with no side effects - the bridge handles
 * all UI updates, store mutations, and network requests based on the
 * returned scenario.
 */
export function classifyActionResponse(
  input: ClassifierInput,
): ActionScenario {
  // Check if user navigated away during the action
  const userNavigatedAway =
    input.currentPathname !== input.actionStartPathname ||
    input.currentLocationKey !== input.actionStartLocationKey;

  if (userNavigatedAway) {
    const historyKeyChanged =
      input.currentLocationKey !== input.actionStartLocationKey;
    return {
      type: "navigated-away",
      historyKeyChanged,
      onInterceptRoute: input.currentInterceptSource !== null,
    };
  }

  // HMR resilience: segments missing after reconciliation
  if (input.reconciledSegmentCount < input.matchedCount) {
    return { type: "hmr-missing" };
  }

  // Consolidation needed for concurrent actions
  if (
    input.consolidationSegments &&
    input.consolidationSegments.length > 0
  ) {
    return {
      type: "consolidation-needed",
      segmentIds: input.consolidationSegments,
    };
  }

  // Other actions still fetching - skip UI update
  if (input.otherFetchingActionCount > 0) {
    return {
      type: "concurrent-skip",
      otherFetchingCount: input.otherFetchingActionCount,
    };
  }

  // Normal single-action completion
  return { type: "normal" };
}
