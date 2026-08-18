/**
 * The clientUrls revalidate() chain evaluator, shared by the browser
 * collector (navigation.ts) and the public testing primitive
 * (testing/run-client-revalidate.ts) so the two can never drift.
 *
 * Semantics mirror the server's evaluateRevalidation
 * (src/router/revalidation.ts): a boolean verdict is a hard decision and
 * short-circuits the rest of the chain; a `{ defaultShouldRevalidate }`
 * object updates the running suggestion, which later predicates receive as
 * their `defaultShouldRevalidate`; null/undefined defers; a throwing
 * predicate fails open to the current suggestion (logged). One deliberate
 * divergence: the object form is accepted only with a boolean value — the
 * server is laxer, but never re-compares the value, while this decision
 * feeds a strict-equality delta gate and the wire encoding
 * (navigation.ts), where a truthy non-boolean would invert intent.
 */

import { paramsEqual } from "../router/params-util.js";
import type { ClientRevalidateArgs, ClientRevalidateFn } from "./types.js";

/**
 * The locked default the server will apply to the request these decisions
 * ride on. `actionRequest` is about the REQUEST, not the user gesture: only
 * the action POST itself is evaluated server-side with actionContext
 * (default `true`); the follow-up refetch GETs an action can trigger carry
 * no actionContext and get navigation defaults — even though their
 * predicates still see `isAction()` as true.
 */
export function lockedClientDefault(options: {
  actionRequest: boolean;
  currentParams: Record<string, string>;
  nextParams: Record<string, string>;
  currentUrl: URL;
  nextUrl: URL;
}): boolean {
  if (options.actionRequest) return true;
  return (
    !paramsEqual(options.currentParams, options.nextParams) ||
    options.currentUrl.search !== options.nextUrl.search
  );
}

export function runClientRevalidateChain(
  fns: readonly ClientRevalidateFn[],
  baseArgs: Omit<ClientRevalidateArgs, "defaultShouldRevalidate">,
  lockedDefault: boolean,
  label: string,
): boolean {
  let suggestion = lockedDefault;
  for (const fn of fns) {
    let verdict: ReturnType<ClientRevalidateFn>;
    try {
      verdict = fn({ ...baseArgs, defaultShouldRevalidate: suggestion });
    } catch (error) {
      console.error(
        `[@rangojs/router] clientUrls revalidate() threw for ${label}; using default decision:`,
        error,
      );
      continue;
    }
    if (
      process.env.NODE_ENV !== "production" &&
      verdict != null &&
      typeof (verdict as { then?: unknown }).then === "function"
    ) {
      console.warn(
        `[rango] clientUrls revalidate() for ${label} returned a Promise; ` +
          `predicates must be synchronous (return a boolean, ` +
          `{ defaultShouldRevalidate }, or null/undefined). The async result ` +
          `was IGNORED and the default (${suggestion}) was kept.`,
      );
    }
    if (typeof verdict === "boolean") return verdict;
    if (
      verdict &&
      typeof verdict === "object" &&
      typeof verdict.defaultShouldRevalidate === "boolean"
    ) {
      suggestion = verdict.defaultShouldRevalidate;
    }
  }
  return suggestion;
}
