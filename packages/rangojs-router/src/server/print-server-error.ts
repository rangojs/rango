/**
 * The server console's record of a failure: its original error, message and
 * stack, printed once per request where it originated, in dev and production.
 * Only what reaches the client is masked (router/error-handling.ts
 * createErrorInfo, React's Flight error rows). A leaf module: the cache layer
 * reads it too.
 */
import { isAbortedRender, isLoaderSignalError, isSkip } from "../errors.js";

/** The request context fields the record reads. */
interface PrintContext {
  /** The errors this request printed (request-context.ts). */
  _printedErrors?: WeakSet<object>;
  request?: Request;
}

/**
 * Control flow, never printed: notFound(), a redirect (a thrown Response or a
 * loader's redirect marker), Skip, and the render's own cancellation.
 */
function isControlFlow(
  error: unknown,
  requestContext: PrintContext | undefined,
): boolean {
  return (
    error instanceof Response ||
    isLoaderSignalError(error) ||
    isSkip(error) ||
    isAbortedRender(error, requestContext?.request?.signal)
  );
}

function printedSet(
  requestContext: PrintContext | undefined,
): WeakSet<object> | undefined {
  if (!requestContext) return undefined;
  return (requestContext._printedErrors ??= new WeakSet());
}

/**
 * Print a server-side failure where it originates:
 * `[RSC] <label> (<name>) <pathname>:` and the error object. Once per request:
 * another place that sees the same error object in `requestContext` prints
 * nothing more. A caller that can run outside the request's ALS frame (a
 * Flight onError) passes the context it captured.
 */
export function printServerError(
  error: unknown,
  origin: { label: string; name?: string; pathname?: string },
  requestContext: PrintContext | undefined,
): void {
  if (isControlFlow(error, requestContext)) return;
  if (typeof error === "object" && error !== null) {
    const printed = printedSet(requestContext);
    if (printed?.has(error)) return;
    printed?.add(error);
  }
  const name = origin.name ? ` (${origin.name})` : "";
  const path = origin.pathname ? ` ${origin.pathname}` : "";
  console.error(`[RSC] ${origin.label}${name}${path}:`, error);
}

/**
 * Record an error this module did not print as done: the SSR render printed it
 * in its own module graph, or it is a copy (a loader's masked rebuild, an
 * error Flight decoded) whose original printed where it started.
 */
export function markServerErrorPrinted(
  error: unknown,
  requestContext: PrintContext | undefined,
): void {
  if (typeof error === "object" && error !== null) {
    printedSet(requestContext)?.add(error);
  }
}

/** Whether this request printed `error`, or recorded it as done. */
export function wasServerErrorPrinted(
  error: unknown,
  requestContext: PrintContext | undefined,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    requestContext?._printedErrors?.has(error) === true
  );
}
