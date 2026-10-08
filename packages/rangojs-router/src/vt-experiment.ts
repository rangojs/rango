/**
 * Measurement switch for the #1078 idle-view-transition candidates. Not for
 * merge. Unset means main's behavior, so every candidate is off by default.
 *
 * Per page: `window.__RANGO_VT_EXP`, set before the app boots (the base-cost
 * recorders do it with an init script). Per server or build: the
 * `__RANGO_VT_EXP_DEFAULT__` define (e2e/test-app/vite.config.ts fills it from
 * the RANGO_VT_EXP env), which reaches the server and the client bundle alike.
 *
 * - "a": the route's pending client references settle before the first commit.
 * - "b1": a commit without a transition type does not animate a router boundary.
 * - "b2": a loading() fallback inside a router boundary is its own boundary
 *   with update "none".
 * - "c0" | "c30" | "c100": a cold navigation waits that long for the response
 *   to complete before its first commit.
 * - "d": a view transition in which React cancelled every group is skipped.
 */
declare const __RANGO_VT_EXP_DEFAULT__: string | undefined;

export function vtExperiment(): string | undefined {
  const perPage = (globalThis as { __RANGO_VT_EXP?: string }).__RANGO_VT_EXP;
  if (perPage) return perPage;
  const fallback =
    typeof __RANGO_VT_EXP_DEFAULT__ === "string"
      ? __RANGO_VT_EXP_DEFAULT__
      : "";
  return fallback || undefined;
}
