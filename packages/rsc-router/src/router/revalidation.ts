/**
 * Router Revalidation Logic
 *
 * Evaluates whether segments should revalidate based on params, actions, and custom functions.
 */

import type { ResolvedSegment, HandlerContext } from "../types";
import type { ActionContext } from "./types";

/**
 * Evaluate if a segment should revalidate using soft/hard decision pattern
 * Optimized to use prevParams directly and avoid building previous segments
 *
 * @param segment - Current segment to evaluate
 * @param prevParams - Previous route params (from route match, not segment)
 * @param getPrevSegment - Lazy function to get previous segment if needed
 * @param request - Current request
 * @param prevUrl - Previous URL
 * @param nextUrl - Next URL
 * @param revalidations - Custom revalidation functions
 * @param routeKey - Current route key
 * @param context - Handler context
 * @param actionContext - Action context if triggered by action
 */
export async function evaluateRevalidation<TEnv>(
  segment: ResolvedSegment,
  prevParams: Record<string, string>,
  getPrevSegment: (() => Promise<ResolvedSegment | undefined>) | null,
  request: Request,
  prevUrl: URL,
  nextUrl: URL,
  revalidations: Array<{ name: string; fn: any }>,
  routeKey: string,
  context: HandlerContext<any, TEnv>,
  actionContext?: ActionContext
): Promise<boolean> {
  const nextParams = segment.params || {};
  const paramsChanged =
    Object.keys(nextParams).length !== Object.keys(prevParams).length ||
    Object.keys(nextParams).some(
      (key) => nextParams[key] !== prevParams[key]
    );

  // Calculate default revalidation based on segment type and request method
  let defaultShouldRevalidate: boolean;

  if (request.method === "POST") {
    // Actions: revalidate segments that belong to the route, skip parent chain
    if (segment.type === "route") {
      // Route segment always revalidates on actions
      defaultShouldRevalidate = true;
    } else if (segment.belongsToRoute) {
      // Segment belongs to route (orphan layouts/parallels) - revalidate
      defaultShouldRevalidate = true;
    } else {
      // Parent chain segment (shared layouts/parallels) - don't revalidate
      defaultShouldRevalidate = false;
    }
  } else {
    // Navigation (GET): Conservative defaults to minimize unnecessary revalidations
    // Only the route segment revalidates by default - all others require explicit opt-in

    if (segment.type === "route") {
      // Route segments revalidate when params change
      // Routes are the primary param-dependent content and always need updates
      defaultShouldRevalidate = paramsChanged;
      if (paramsChanged) {
        console.log(
          `[Router.evaluateRevalidation] ${segment.id}: ROUTE - params changed, revalidating`
        );
      }
    } else {
      // Layouts and parallels default to no revalidation
      // Cannot assume these segments depend on params without explicit declaration
      // Use custom revalidation functions to opt-in when needed
      defaultShouldRevalidate = false;
      console.log(
        `[Router.evaluateRevalidation] ${
          segment.id
        }: ${segment.type.toUpperCase()} segment - skipping (override with custom revalidation if needed)`
      );
    }
  }

  // No custom revalidations defined - return default behavior without prev segment
  if (revalidations.length === 0) {
    if (defaultShouldRevalidate) {
      console.log(
        `[Router.evaluateRevalidation] ${segment.id}: PARAMS CHANGED (default) - revalidating`,
        { prev: prevParams, next: nextParams }
      );
    } else {
      console.log(
        `[Router.evaluateRevalidation] ${segment.id}: UNCHANGED (default) - skipping`
      );
    }
    return defaultShouldRevalidate;
  }

  // Custom revalidations exist - may need full prev segment
  // Lazy load prev segment only if getPrevSegment provided
  const prevSegment = getPrevSegment ? await getPrevSegment() : null;

  // Execute revalidation functions with soft/hard decision pattern
  let currentSuggestion = defaultShouldRevalidate;

  for (const { name, fn } of revalidations) {
    const result = fn({
      currentParams: prevSegment?.params || prevParams, // Use segment params if available, else route params
      currentUrl: prevUrl,
      nextParams,
      nextUrl,
      defaultShouldRevalidate: currentSuggestion,
      context,
      // Segment metadata (which segment is being evaluated)
      segmentType: segment.type,
      layoutName: segment.layoutName,
      slotName: segment.slot,
      // Action context (only populated when triggered by server action)
      actionId: actionContext?.actionId,
      actionUrl: actionContext?.actionUrl,
      actionResult: actionContext?.actionResult,
      formData: actionContext?.formData,
      method: request.method, // GET for navigation, POST for actions
      routeName: routeKey, // User-friendly route name (e.g., "products.detail")
    });

    // Check return type:
    // - boolean: hard decision, short-circuit immediately
    // - { defaultShouldRevalidate: boolean }: soft decision, update suggestion and continue
    // - null/undefined: use default behavior (equivalent to returning { defaultShouldRevalidate })
    if (typeof result === "boolean") {
      // Hard decision - short-circuit
      console.log(
        `[Router.evaluateRevalidation] ${segment.id}: REVALIDATE (${name}) HARD: ${result}`
      );
      return result;
    } else if (
      result &&
      typeof result === "object" &&
      "defaultShouldRevalidate" in result
    ) {
      // Soft decision - update suggestion and continue
      currentSuggestion = result.defaultShouldRevalidate;
      console.log(
        `[Router.evaluateRevalidation] ${segment.id}: REVALIDATE (${name}) SOFT: ${currentSuggestion}`
      );
    } else if (result === null || result === undefined) {
      // Defer to default - equivalent to { defaultShouldRevalidate: currentSuggestion }
      // This means "I don't care, use whatever the default is"
      console.log(
        `[Router.evaluateRevalidation] ${segment.id}: REVALIDATE (${name}) DEFER to default: ${currentSuggestion}`
      );
      // currentSuggestion stays the same, continue to next function
    }
  }

  // All revalidators completed - use final suggestion
  console.log(
    `[Router.evaluateRevalidation] ${segment.id}: Final decision: ${currentSuggestion}`
  );
  return currentSuggestion;
}
