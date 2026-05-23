/**
 * Router discovery error aggregation.
 *
 * During host-router discovery the lazy mounts registered by a host router are
 * invoked to trigger each sub-app's createRouter() registration. Some mount
 * failures are expected in the temporary discovery server context (a sub-app may
 * reference runtime-only bindings), so each is invoked defensively and its error
 * is collected rather than thrown.
 *
 * Previously these errors were discarded with an empty `catch {}`. When a real
 * failure - typically a sub-app whose router module fails to import - left the
 * registry empty, discovery reported the misleading "No routers found" message
 * with no trace of the underlying cause. The collected errors are now surfaced
 * via the `DiscoveryError` thrown at the end of discovery (issue #499).
 *
 * Which entries to invoke is taken from the consumer's declared intent, not
 * inferred from the function's shape. A host route is registered either with
 * `.map((request) => Response)` (an inline request handler, `kind: "handler"`)
 * or `.lazy(() => import("./sub-app"))` (a lazy mount, `kind: "lazy"`). Only
 * `kind === "lazy"` entries are invoked here; inline handlers are never invoked
 * during discovery (they need a Request and register no routers). Because a lazy
 * entry is known to be a module loader, ANY failure it produces - a synchronous
 * throw or a rejected promise - is a genuine discovery failure and is collected.
 */

/** An error caught (and previously swallowed) while resolving host routers. */
export interface CaughtDiscoveryError {
  /** Human-readable description of where the error was caught. */
  context: string;
  /** The caught value (an Error or otherwise). */
  error: unknown;
}

/**
 * Minimal shape of a host registry entry needed for mount resolution.
 * Mirrors the runtime HostRouterRegistry value without coupling to its type.
 */
interface HostRegistryRoute {
  handler?: unknown;
  kind?: string;
}
interface HostRegistryEntry {
  routes: HostRegistryRoute[];
  fallback?: HostRegistryRoute | null;
}

/** Indent every non-empty line of `text` by `pad`. */
function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

/**
 * Invoke a single lazy mount to trigger its sub-app import (and createRouter()
 * registration), collecting any failure under `context`. The entry is known to
 * be a loader (`kind === "lazy"`), so both a synchronous throw and a rejected
 * promise are genuine failures - no shape heuristics are needed.
 */
async function invokeLazyMount(
  loader: () => unknown,
  context: string,
  errors: CaughtDiscoveryError[],
): Promise<void> {
  try {
    await loader();
  } catch (error) {
    errors.push({ context, error });
  }
}

/** Whether a registry route is a `.lazy()` mount with an invokable loader. */
function isLazyMount(
  route: HostRegistryRoute | null | undefined,
): route is { handler: () => unknown; kind: "lazy" } {
  return (
    !!route && route.kind === "lazy" && typeof route.handler === "function"
  );
}

/**
 * Invoke every lazy mount in the host registry to trigger sub-app
 * createRouter() registration, collecting (not throwing) any failures.
 *
 * Only `.lazy()` entries are invoked; `.map()` inline request handlers are
 * skipped (they need a Request and register no routers). Failures are returned
 * rather than thrown because some mounts legitimately fail in the temporary
 * discovery server context; the caller decides whether the failures matter,
 * which is only when discovery finds no routers at all.
 */
export async function resolveHostRouterHandlers(
  hostRegistry: Map<string, HostRegistryEntry>,
): Promise<CaughtDiscoveryError[]> {
  const errors: CaughtDiscoveryError[] = [];

  for (const [hostId, entry] of hostRegistry) {
    for (const route of entry.routes) {
      if (isLazyMount(route)) {
        await invokeLazyMount(
          route.handler,
          `host "${hostId}" route handler`,
          errors,
        );
      }
    }
    if (isLazyMount(entry.fallback)) {
      await invokeLazyMount(
        entry.fallback.handler,
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
  const base = `[rango] No routers found in registry after importing ${entryPath}`;
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
