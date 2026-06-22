import { validateRedirectOrigin } from "./validate-redirect-origin.js";

type HeaderResult = { url: string } | "blocked" | null;

/**
 * Null-body statuses: the Fetch spec forbids pairing these with a body, so
 * `new Response(body, { status })` throws ("Response with null body status
 * cannot have body"). fetch() can still surface one WITH a body straight from
 * the network layer (never the JS constructor): a 304 stale-while-revalidate
 * prefetch revalidated to Not Modified (body from cache), or a 204 soft
 * redirect. teeWithCompletion must not re-run those through `new Response`.
 */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * Extract and validate an RSC response header URL (X-RSC-Reload, X-RSC-Redirect).
 * Returns { url } if valid, "blocked" if present but invalid origin, null if absent.
 */
export function extractRscHeaderUrl(
  response: Response,
  header: string,
): HeaderResult {
  const raw = response.headers.get(header);
  if (!raw) return null;
  const url = validateRedirectOrigin(raw, window.location.origin);
  return url ? { url } : "blocked";
}

/**
 * Empty 200 response that won't choke Flight parsing.
 * Used when a header URL is blocked by origin validation.
 */
export function emptyResponse(): Response {
  return new Response(null, { status: 200 });
}

/**
 * Whether an RSC content response carries a server-stamped router identity
 * (`X-RSC-Router-Id`) that DIFFERS from the id this client expects (its own
 * routerId, also sent as `_rsc_rid`). Pre-decode integrity check: lets a caller
 * refuse a foreign app's payload before `createFromFetch` imports its chunks.
 *
 * True ONLY when both the header and the expected id are present and differ. An
 * absent header (control-only reload/redirect responses are not stamped) or an
 * absent expected id (e.g. before the client is seeded) is a pass-through —
 * never a false reject.
 */
export function isForeignRouterId(
  response: Response,
  expectedId: string | undefined,
): boolean {
  const got = response.headers.get("X-RSC-Router-Id");
  if (!got || !expectedId) return false;
  return got !== expectedId;
}

/**
 * Handle the X-RSC-Reload control header (server requests a full page reload on
 * a version mismatch). Returns a short-circuit response when the header is
 * present -- emptyResponse() if the URL was blocked by origin validation, or a
 * never-resolving promise while the page reloads -- and null when absent, so
 * the caller continues processing (e.g. the X-RSC-Redirect check). Scoped to
 * X-RSC-Reload only; redirect handling differs between callers.
 */
export function handleReloadHeader(
  response: Response,
  opts: { onBlocked: () => void; onReload: (url: string) => void },
): Response | Promise<Response> | null {
  const reload = extractRscHeaderUrl(response, "X-RSC-Reload");
  if (reload === "blocked") {
    opts.onBlocked();
    return emptyResponse();
  }
  if (reload) {
    opts.onReload(reload.url);
    window.location.href = reload.url;
    return new Promise<Response>(() => {});
  }
  return null;
}

/**
 * Tee a response body for RSC parsing and stream completion tracking.
 * Returns a new Response with one branch; the other is consumed to detect
 * end-of-stream, calling onComplete when done.
 *
 * If the response has no body, onComplete fires synchronously.
 * If signal is provided, an abort cancels the tracking reader.
 *
 * `silent` suppresses the stream-error log. Prefetch passes it: a speculative,
 * low-priority prefetch that is aborted or never consumed can error its stream
 * benignly, which is not worth surfacing. The fresh-navigation path keeps the
 * log (default), where a stream error reflects a real failed navigation.
 */
export function teeWithCompletion(
  response: Response,
  onComplete: () => void,
  signal?: AbortSignal,
  silent = false,
): Response {
  // Once-guard: a mid-stream read error runs both the finally block and the
  // rejection's .catch, so onComplete must be settled exactly once across all
  // paths (no-body early return, finally, catch).
  let settled = false;
  const settle = () => {
    if (!settled) {
      settled = true;
      onComplete();
    }
  };

  // Empty body, or a null-body status fetch() paired with a body: either way the
  // body can't be re-attached via `new Response` below. Settle and pass the
  // original response through; its body (when present) stays readable downstream.
  if (!response.body || NULL_BODY_STATUS.has(response.status)) {
    settle();
    return response;
  }

  const [rscStream, trackingStream] = response.body.tee();

  (async () => {
    const reader = trackingStream.getReader();
    const onAbort = signal ? reader.cancel.bind(reader) : undefined;
    if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      if (onAbort) signal!.removeEventListener("abort", onAbort);
      reader.releaseLock();
      settle();
    }
  })().catch((error) => {
    if (!silent && !signal?.aborted) {
      console.error("[Browser] Error reading tracking stream:", error);
    }
    settle();
  });

  return new Response(rscStream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}
