/**
 * Router Revalidation Logic
 *
 * Evaluates whether segments should revalidate based on params, actions, and custom functions.
 */

import type { ResolvedSegment, HandlerContext } from "../types";
import type { ActionContext } from "./types";
import { debugLog } from "./logging.js";

function paramsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  if (a === b) return true;

  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;

  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }

  return true;
}

/**
 * Options for revalidation evaluation
 */
interface EvaluateRevalidationOptions<TEnv> {
  /** Current segment to evaluate */
  segment: ResolvedSegment;
  /** Previous route params (from route match, not segment) */
  prevParams: Record<string, string>;
  /** Lazy function to get previous segment if needed */
  getPrevSegment: (() => Promise<ResolvedSegment | undefined>) | null;
  /** Current request */
  request: Request;
  /** Previous URL */
  prevUrl: URL;
  /** Next URL */
  nextUrl: URL;
  /** Custom revalidation functions */
  revalidations: Array<{ name: string; fn: any }>;
  /** Current route key */
  routeKey: string;
  /** Handler context */
  context: HandlerContext<any, TEnv>;
  /** Action context if triggered by action */
  actionContext?: ActionContext;
  /** If true, this is a stale cache revalidation request */
  stale?: boolean;
}

/**
 * Evaluate if a segment should revalidate using soft/hard decision pattern
 * Optimized to use prevParams directly and avoid building previous segments
 */
export async function evaluateRevalidation<TEnv>(
  options: EvaluateRevalidationOptions<TEnv>,
): Promise<boolean> {
  const {
    segment,
    prevParams,
    getPrevSegment,
    request,
    prevUrl,
    nextUrl,
    revalidations,
    routeKey,
    context,
    actionContext,
    stale,
  } = options;
  const nextParams = segment.params || {};
  const paramsChanged = !paramsEqual(nextParams, prevParams);

  // Calculate default revalidation based on segment type and request method
  let defaultShouldRevalidate: boolean;

  if (request.method === "POST") {
    // Actions: revalidate segments that belong to the route, skip parent chain
    if (segment.type === "route") {
      // Route segment always revalidates on actions
      defaultShouldRevalidate = true;
    } else if (segment.type === "loader") {
      // Loaders always revalidate on actions - they often contain action-sensitive data
      // (e.g., cart count after add-to-cart action)
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
        debugLog("revalidation", "route params changed, revalidating", {
          segmentId: segment.id,
        });
      }
    } else {
      // Layouts and parallels default to no revalidation
      // Cannot assume these segments depend on params without explicit declaration
      // Use custom revalidation functions to opt-in when needed
      defaultShouldRevalidate = false;
      debugLog("revalidation", "non-route segment skipped by default", {
        segmentId: segment.id,
        segmentType: segment.type,
      });
    }
  }

  // No custom revalidations defined - return default behavior without prev segment
  if (revalidations.length === 0) {
    if (defaultShouldRevalidate) {
      debugLog("revalidation", "default revalidate=true", {
        segmentId: segment.id,
        prevParams,
        nextParams,
      });
    } else {
      debugLog("revalidation", "default revalidate=false", {
        segmentId: segment.id,
      });
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
      // Stale cache context (only true for background revalidation after stale cache render)
      stale,
    });

    // Check return type:
    // - boolean: hard decision, short-circuit immediately
    // - { defaultShouldRevalidate: boolean }: soft decision, update suggestion and continue
    // - null/undefined: use default behavior (equivalent to returning { defaultShouldRevalidate })
    if (typeof result === "boolean") {
      // Hard decision - short-circuit
      debugLog("revalidation", "hard decision", {
        segmentId: segment.id,
        revalidator: name,
        revalidate: result,
      });
      return result;
    } else if (
      result &&
      typeof result === "object" &&
      "defaultShouldRevalidate" in result
    ) {
      // Soft decision - update suggestion and continue
      currentSuggestion = result.defaultShouldRevalidate;
      debugLog("revalidation", "soft decision", {
        segmentId: segment.id,
        revalidator: name,
        revalidate: currentSuggestion,
      });
    } else if (result === null || result === undefined) {
      // Defer to default - equivalent to { defaultShouldRevalidate: currentSuggestion }
      // This means "I don't care, use whatever the default is"
      debugLog("revalidation", "deferred to current default", {
        segmentId: segment.id,
        revalidator: name,
        revalidate: currentSuggestion,
      });
      // currentSuggestion stays the same, continue to next function
    }
  }

  // All revalidators completed - use final suggestion
  debugLog("revalidation", "final decision", {
    segmentId: segment.id,
    revalidate: currentSuggestion,
  });
  return currentSuggestion;
}
