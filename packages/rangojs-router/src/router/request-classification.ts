/**
 * Request Classification
 *
 * Phase 2 of the route resolution refactor. Replaces the implicit
 * "preview then match again" model with a clean two-stage architecture:
 *
 * 1. Request Classification — classifyRequest() produces a RequestPlan
 *    that answers all routing questions once: target route, request mode,
 *    route middleware, navigation state, intercept plan.
 *
 * 2. Request Execution — executeRequest() dispatches on the plan to the
 *    appropriate handler (response route, loader fetch, full render,
 *    partial render, action revalidation, PE render).
 *
 * Today handler.ts calls previewMatch() for lightweight route classification,
 * then match()/matchPartial() re-derives the same route state from scratch.
 * This means route derivation is split between preview and match, handler
 * code is a sequence of overlapping mini-matches, and the "preview" concept
 * leaks into the API surface when it should be an implementation detail.
 *
 * The cleaner model: one authoritative classification step, then execution
 * from that plan.
 *
 * Builds on RouteSnapshot + NavigationSnapshot from route-snapshot.ts and
 * navigation-snapshot.ts.
 */

import type { RouteSnapshot } from "./route-snapshot.js";
import type { NavigationSnapshot } from "./navigation-snapshot.js";

/**
 * Request mode — what kind of request this is.
 */
export type RequestMode =
  | "response" // Response route (non-RSC short-circuit: JSON, streaming, etc.)
  | "loader" // Loader fetch (_rsc_loader)
  | "full-render" // Full document/SSR render
  | "partial-render" // Partial navigation render
  | "action-revalidate" // Server action + revalidation
  | "pe-render"; // Progressive enhancement (no-JS form submission)

/**
 * The output of request classification. Contains everything needed to
 * execute the request without re-deriving route state.
 *
 * TODO: Fill in concrete fields as implementation progresses.
 */
export interface RequestPlan<TEnv = any> {
  /** What kind of request this is */
  mode: RequestMode;
  /** The resolved target route */
  route: RouteSnapshot<TEnv>;
  /** Navigation state (only for partial/action modes) */
  navigation: NavigationSnapshot | null;
}
