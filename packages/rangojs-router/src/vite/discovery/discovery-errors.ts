/**
 * Router discovery error aggregation.
 *
 * During host-router discovery the lazy route handlers registered by a host
 * router are invoked to trigger each sub-app's createRouter() registration.
 * Some handler failures are expected in the temporary discovery server context
 * (a sub-app may reference runtime-only bindings), so each handler is invoked
 * defensively and its error is collected rather than thrown.
 *
 * Previously these errors were discarded with an empty `catch {}`. When a real
 * failure - typically a sub-app whose router module fails to import - left the
 * registry empty, discovery reported the misleading "No routers found" message
 * with no trace of the underlying cause. The collected errors are now surfaced
 * via the `DiscoveryError` thrown at the end of discovery (issue #499).
 *
 * A host pattern can be mapped to a lazy module loader (`() => import(...)`) or
 * to an inline request handler (`(request, input) => Response`). Only the lazy
 * loaders should be invoked during discovery; an inline handler invoked without
 * a Request dereferences `undefined` (e.g. `request.url`) and throws, which is
 * unrelated to module resolution and must not be collected as an import failure.
 *
 * The two shapes are not distinguishable before invocation - both are plain
 * functions on the registry entry with no tag, and arity alone is not a gate
 * because a lazy loader may legally declare an (ignored) optional parameter,
 * e.g. `(_request?: Request) => import("./app")` compiles to an arity-1
 * function. They are therefore separated by what an argument-less invocation
 * produces (see `triggerLazyImport`): a thenable result is a real import
 * (awaited, its rejection collected); a non-thenable result is an inline
 * handler that returned a value (ignored); a synchronous throw is split by
 * arity - a declared-param handler is an inline handler crashing on the missing
 * Request (ignored), while a zero-arity handler has no Request to dereference,
 * so its throw is a genuine loader failure and is collected.
 */

/** An error caught (and previously swallowed) while resolving host routers. */
export interface CaughtDiscoveryError {
  /** Human-readable description of where the error was caught. */
  context: string;
  /** The caught value (an Error or otherwise). */
  error: unknown;
}

/**
 * Minimal shape of a host registry entry needed for handler resolution.
 * Mirrors the runtime HostRouterRegistry value without coupling to its type.
 */
interface HostRegistryEntry {
  routes: Array<{ handler?: unknown }>;
  fallback?: { handler?: unknown } | null;
}

/** Indent every non-empty line of `text` by `pad`. */
function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

/** Whether a value is thenable (a Promise or Promise-like). */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Invoke one host route handler argument-less to trigger a lazy
 * `() => import(...)` loader, collecting only genuine module-import failures.
 *
 * A handler is classified by what the argument-less invocation produces, since
 * lazy loaders and inline request handlers are otherwise indistinguishable
 * (arity is unreliable - a lazy loader may declare `(_request?) => import(...)`):
 *
 *   - Thenable result -> a real lazy import. Awaited; a rejection is a genuine
 *     discovery failure (e.g. the sub-app module cannot be resolved) and is
 *     collected under `context`. This covers both `() => import(...)` and a
 *     param-declaring `(_request?) => import(...)`.
 *   - Non-thenable result (a Response, URL, etc.) -> an inline handler that ran
 *     to completion without a Request. Ignored; not a module load.
 *   - Synchronous throw -> split by arity:
 *       - declared params (arity >= 1): an inline request handler dereferencing
 *         the missing Request (e.g. `request.url` on `undefined`). Ignored, so
 *         it does not pollute the aggregated DiscoveryError.
 *       - zero arity: no Request to dereference, so the throw is a genuine lazy
 *         loader failure that happened before `import()` returned (e.g. a guard
 *         `() => { assertEnv(); return import(...) }`). Collected, preserving
 *         the cause for the "no routers found" error (issue #501).
 *
 * Residuals (both narrow, and at worst only mildly pollute an already-failing
 * "no routers found" discovery): an async inline handler
 * (`async (request) => { ...request... }`) returns a rejected promise
 * indistinguishable from a failed import, so its error is collected; and a
 * param-declaring lazy loader that throws *synchronously* before its import is
 * treated as an inline crash and ignored. Eliminating either would require
 * tagging lazy loaders at the public `map()` API, churning the documented
 * `.map(() => import(...))` pattern.
 */
async function triggerLazyImport(
  handler: () => unknown,
  context: string,
  errors: CaughtDiscoveryError[],
): Promise<void> {
  let result: unknown;
  try {
    result = handler();
  } catch (error) {
    // Synchronous throw. A declared-param handler is an inline request handler
    // crashing on the missing Request (not a module-import failure) - ignore.
    // A zero-arity handler has no Request to dereference, so the throw is a
    // genuine lazy-loader failure that occurred before `import()` returned -
    // collect it so the "no routers found" error keeps the real cause.
    if (handler.length === 0) {
      errors.push({ context, error });
    }
    return;
  }
  // A non-thenable return is an inline handler that produced a value (e.g. a
  // Response) rather than a module import. Only thenables are awaited and their
  // rejection collected as a real failure.
  if (!isThenable(result)) {
    return;
  }
  try {
    await result;
  } catch (error) {
    errors.push({ context, error });
  }
}

/**
 * Invoke every lazy module loader in the host registry to trigger sub-app
 * createRouter() registration, collecting (not throwing) any failures.
 *
 * Every function handler is invoked; lazy loaders vs inline request handlers
 * are separated by `triggerLazyImport` based on the invocation result (a thenable
 * is a real import, regardless of arity), with arity used only to classify a
 * synchronous throw (a zero-arity throw is a real loader failure; a declared-param
 * throw is an inline handler crashing on the missing Request).
 *
 * Failures are returned rather than thrown because some loaders legitimately
 * fail in the temporary discovery server context; the caller decides whether
 * the failures matter, which is only when discovery finds no routers at all.
 */
export async function resolveHostRouterHandlers(
  hostRegistry: Map<string, HostRegistryEntry>,
): Promise<CaughtDiscoveryError[]> {
  const errors: CaughtDiscoveryError[] = [];

  for (const [hostId, entry] of hostRegistry) {
    for (const route of entry.routes) {
      if (typeof route.handler === "function") {
        await triggerLazyImport(
          route.handler as () => unknown,
          `host "${hostId}" route handler`,
          errors,
        );
      }
    }
    if (entry.fallback && typeof entry.fallback.handler === "function") {
      await triggerLazyImport(
        entry.fallback.handler as () => unknown,
        `host "${hostId}" fallback handler`,
        errors,
      );
    }
  }

  return errors;
}

/**
 * Build the terminal "No routers found" message, appending any errors caught
 * during host-router discovery so the real cause is visible.
 *
 * The aggregated errors are inlined into the message (in addition to being
 * attached via `cause` on `DiscoveryError`) so they survive every caller: the
 * dev/HMR paths log `err.message`, and the build path re-throws using
 * `err.stack`, which begins with the message. None of those callers traverse
 * `cause`, so the message must carry the detail. Each error includes its stack
 * when available.
 */
export function formatNoRoutersError(
  entryPath: string | undefined,
  errors: CaughtDiscoveryError[],
): string {
  const base = `[rsc-router] No routers found in registry after importing ${entryPath}`;
  if (errors.length === 0) {
    return base;
  }

  const formatted = errors
    .map(({ context, error }) => {
      const err = error instanceof Error ? error : new Error(String(error));
      const detail = err.stack ?? err.message;
      return `  - while resolving ${context}:\n${indent(detail, "      ")}`;
    })
    .join("\n");

  return (
    `${base}\n\n` +
    `${errors.length} error(s) were caught during host-router discovery and ` +
    `likely explain why no routers were registered:\n${formatted}`
  );
}

/**
 * Reduce the caught errors to an `ErrorOptions.cause`: a single failure becomes
 * the direct cause; multiple failures are wrapped in an `AggregateError` so
 * each underlying error remains reachable. No errors -> no cause.
 */
function toCause(errors: CaughtDiscoveryError[]): unknown {
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0].error;
  return new AggregateError(
    errors.map((e) => e.error),
    "Multiple host-router handlers failed during discovery",
  );
}

/**
 * Thrown when router discovery completes without finding any routers.
 *
 * Carries the entry path and the individual failures caught while resolving
 * host-router lazy handlers. The formatted detail is embedded in `message` (for
 * callers that log `err.message`/`err.stack`) and the underlying error(s) are
 * also attached via `cause` (a single failure directly, multiple wrapped in an
 * `AggregateError`) for cause-aware tooling such as the Vite error overlay.
 */
export class DiscoveryError extends Error {
  /** The entry file that was imported before discovery gave up. */
  readonly entryPath: string | undefined;
  /** Individual failures caught while resolving host-router handlers. */
  readonly caught: CaughtDiscoveryError[];

  constructor(entryPath: string | undefined, caught: CaughtDiscoveryError[]) {
    super(formatNoRoutersError(entryPath, caught));
    const cause = toCause(caught);
    if (cause !== undefined) {
      this.cause = cause;
    }
    this.name = "DiscoveryError";
    this.entryPath = entryPath;
    this.caught = caught;
    Object.setPrototypeOf(this, DiscoveryError.prototype);
  }
}
