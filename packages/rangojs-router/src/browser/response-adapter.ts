import { validateRedirectOrigin } from "./validate-redirect-origin.js";

type HeaderResult = { url: string } | "blocked" | null;

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
 * Tee a response body for RSC parsing and stream completion tracking.
 * Returns a new Response with one branch; the other is consumed to detect
 * end-of-stream, calling onComplete when done.
 *
 * If the response has no body, onComplete fires synchronously.
 * If signal is provided, an abort cancels the tracking reader.
 */
export function teeWithCompletion(
  response: Response,
  onComplete: () => void,
  signal?: AbortSignal,
): Response {
  if (!response.body) {
    onComplete();
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
      onComplete();
    }
  })().catch((error) => {
    if (!signal?.aborted) {
      console.error("[Browser] Error reading tracking stream:", error);
    }
    onComplete();
  });

  return new Response(rscStream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}
