/**
 * Router Timeout
 *
 * Types, resolution logic, and helpers for request-level timeouts.
 * Timeouts wrap action execution and render-start phases with
 * a Promise.race mechanism, returning 504 on expiry.
 */

export interface RouterTimeouts {
  /** Timeout for server action execution (ms). */
  actionMs?: number;
  /** Timeout for initial render/response production (ms). */
  renderStartMs?: number;
  /** Timeout for idle streaming after render starts (ms). Reserved for PR 2. */
  streamIdleMs?: number;
}

export type TimeoutPhase = "action" | "render-start" | "stream-idle";

/**
 * Canonical render-pipeline unions, defined here (the dependency-free timeout
 * leaf) and shared by `import type` so the render driver
 * (rsc/render-pipeline.ts RscRenderMode/RscRenderPhase), the foreground cursor
 * (server/request-context.ts RenderForegroundCursor), and RenderTimeoutContext
 * below cannot drift out of sync.
 */
export type RenderMode =
  | "unknown"
  | "full"
  | "partial"
  | "action-revalidation"
  | "progressive-enhancement"
  | "progressive-enhancement-error";

/** Terminal response-construction stage of the render driver. */
export type RenderPhase = "flight" | "html" | "response";

export interface RenderTimeoutContext {
  mode: RenderMode;
  phase: RenderPhase;
  state: "paused" | "running";
  completed: number;
  total: number;
  phaseDurationMs?: number;
}

export interface TimeoutContext<TEnv = any> {
  phase: TimeoutPhase;
  request: Request;
  url: URL;
  env: TEnv;
  routeKey?: string;
  actionId?: string;
  durationMs: number;
  /** Foreground render operation active when a render-start timeout fired. */
  render?: RenderTimeoutContext;
}

export type OnTimeoutCallback<TEnv = any> = (
  ctx: TimeoutContext<TEnv>,
) => Response | Promise<Response>;

export interface ResolvedTimeouts {
  actionMs: number | undefined;
  renderStartMs: number | undefined;
  streamIdleMs: number | undefined;
}

/**
 * Merge the `timeout` shorthand with the structured `timeouts` object.
 *
 * - `timeout` applies to `actionMs` and `renderStartMs` (NOT `streamIdleMs`).
 * - Explicit `timeouts.*` values override the shorthand.
 * - Returns `undefined` for any phase that has no configured value.
 */
export function resolveTimeouts(
  timeout?: number,
  timeouts?: RouterTimeouts,
): ResolvedTimeouts {
  return {
    actionMs: timeouts?.actionMs ?? timeout ?? undefined,
    renderStartMs: timeouts?.renderStartMs ?? timeout ?? undefined,
    streamIdleMs: timeouts?.streamIdleMs ?? undefined,
  };
}

export class RouterTimeoutError extends Error {
  override name = "RouterTimeoutError" as const;
  phase: TimeoutPhase;
  durationMs: number;

  constructor(phase: TimeoutPhase, durationMs: number) {
    super(
      `Request timed out during ${phase} after ${Math.round(durationMs)}ms`,
    );
    this.phase = phase;
    this.durationMs = durationMs;
  }
}

type TimeoutResult<T> =
  | { result: T; timedOut: false }
  | { timedOut: true; durationMs: number };

/**
 * A timeout phase is active only when its budget is a positive number.
 * `undefined`/`null` (unset) and `<= 0` (explicit opt-out, e.g.
 * `timeouts: { renderStartMs: 0 }`) both mean pass-through. withTimeout and the
 * render-diagnostics gate (rsc/handler.ts) share this so a disabled budget can
 * never leave one of them still doing bookkeeping the other can never read.
 */
export function isTimeoutEnabled(timeoutMs: number | undefined): boolean {
  return timeoutMs != null && timeoutMs > 0;
}

/**
 * Race an operation against a deadline.
 *
 * Returns a discriminated union so callers handle the timeout case
 * without try/catch. Non-timeout errors from the operation re-throw.
 *
 * When `timeoutMs` is `undefined` or `<= 0`, the operation runs
 * without any deadline (pass-through).
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  phase: TimeoutPhase,
): Promise<TimeoutResult<T>> {
  if (!isTimeoutEnabled(timeoutMs)) {
    return { result: await operation, timedOut: false };
  }

  const start = performance.now();
  let timer: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RouterTimeoutError(phase, performance.now() - start));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([operation, timeoutPromise]);
    clearTimeout(timer!);
    return { result, timedOut: false };
  } catch (error) {
    clearTimeout(timer!);
    if (error instanceof RouterTimeoutError) {
      return { timedOut: true, durationMs: error.durationMs };
    }
    throw error;
  }
}

/**
 * Create the default 504 response for a timed-out request.
 * Includes `X-Rango-Timeout-Phase` header for observability.
 */
export function createDefaultTimeoutResponse(phase: TimeoutPhase): Response {
  return new Response("Request timed out", {
    status: 504,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "X-Rango-Timeout-Phase": phase,
    },
  });
}
