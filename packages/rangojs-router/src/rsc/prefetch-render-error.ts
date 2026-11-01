/**
 * A prefetch whose render reported an error is not kept (#1170).
 *
 * WHY: its 200 left with the headers before a streamed part failed, so the
 * client stored the error boundary as a healthy prefetch, served it to a
 * click and respawned it. The status cannot change any more, and the body
 * cannot end with an error: workerd delivers an errored body as a clean end,
 * and in Chromium the error drops the rows a click that adopted the prefetch
 * has not decoded yet (a Flight "network error" in place of the page).
 *
 * So the body ends cleanly with one more row, PREFETCH_FAILED_ROW, which the
 * Flight decoder skips and teeWithCompletion (browser/response-adapter.ts)
 * reads as a stream that did not end cleanly: the client evicts the prefetch
 * and never respawns it. The router puts no Cache-Control of its own on a
 * prefetch with a live part, the only kind whose render can report an error
 * here, so the browser HTTP cache keeps none of it unless the route sets one;
 * a prefetch with nothing live in it carries `private, max-age`
 * (request-stages.ts applyStoredPrefetchCacheControl, rango-t82); a prefetch
 * scoped to its source page or carrying deferred units is sent
 * `private, no-cache` (rsc-rendering.ts NOT_REUSED).
 *
 * The errors are the render's `_renderErrors`: a Flight error row, a streamed
 * handler recovered into its boundary, a loader that threw (redirect() and
 * notFound() are not errors). Each is recorded before Flight writes the row
 * that carries it, so the list is complete once Flight closes the stream.
 */

import { PREFETCH_FAILED_ROW } from "../prefetch-markers.js";

export function markPrefetchOnRenderError(
  response: Response,
  renderErrors: readonly unknown[],
): Response {
  if (!response.body) return response;
  const marked = new TransformStream<Uint8Array, Uint8Array>({
    flush(controller) {
      if (renderErrors.length > 0) {
        controller.enqueue(new TextEncoder().encode(PREFETCH_FAILED_ROW));
      }
    },
  });
  return new Response(response.body.pipeThrough(marked), response);
}
