/**
 * Router Timeout
 *
 * Types, resolution logic, and helpers for request-level timeouts.
 * Timeouts wrap action execution and render-start phases with
 * a Promise.race mechanism, returning 504 on expiry.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RouterTimeouts {
  /** Timeout for server action execution (ms). */
  actionMs?: number;
  /** Timeout for initial render/response production (ms). */
  renderStartMs?: number;
  /** Timeout for idle streaming after render starts (ms). Reserved for PR 2. */
  streamIdleMs?: number;
}

export type TimeoutPhase = "action" | "render-start" | "stream-idle";

export interface TimeoutContext<TEnv = any> {
  phase: TimeoutPhase;
  request: Request;
  url: URL;
  env: TEnv;
  routeKey?: string;
  actionId?: string;
  durationMs: number;
}

export type OnTimeoutCallback<TEnv = any> = (
  ctx: TimeoutContext<TEnv>,
) => Response | Promise<Response>;

// ---------------------------------------------------------------------------
// Internal resolved form
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Race helper
// ---------------------------------------------------------------------------

type TimeoutResult<T> =
  | { result: T; timedOut: false }
  | { timedOut: true; durationMs: number };

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
  if (timeoutMs == null || timeoutMs <= 0) {
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

// ---------------------------------------------------------------------------
// Default response
// ---------------------------------------------------------------------------

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
