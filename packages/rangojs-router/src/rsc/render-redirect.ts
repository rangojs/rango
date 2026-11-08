/**
 * A redirect a component threw while React rendered it.
 *
 * React catches a throw inside the render and writes an error row, so nothing
 * reaches the handler: before this module, `throw redirect(...)` from a
 * component (a page, a layout, anything React renders that is not a handler)
 * rendered the nearest error boundary, on a document and on a client
 * navigation alike. A handler's throw answers the redirect instead, and a
 * component's must answer it the same way: 3xx with `Location` on a document,
 * 204 + `X-RSC-Redirect` on a client navigation.
 *
 * The render can only answer it while the response's status is still open.
 * That window is {@link RenderRedirectWindow}: created where the render starts
 * (`createFlightStage`), closed where the status commits:
 * - a Flight response (a client navigation, a prefetch): its opening flush,
 *   where a synchronous component's throw is already serialized
 *   ({@link holdOpeningRedirect});
 * - a document: its shell. Fizz reads the payload the shell needs, so a throw
 *   that failed the shell, and one the opening flush carried, are both known
 *   before the status commits (`createSsrHtmlStage`).
 *
 * A redirect reported after its window closed is out of time: an async
 * component is a task of its own, so its error row lands in a later chunk, and
 * the response is committed. Buffering the whole render to close that gap is
 * what the streaming contract forbids (docs/internal/execution-model.md, "A
 * component that throws redirect() redirects, if the render says so in time"),
 * so that case renders the boundary. It is then a rendering failure like any
 * other: nothing answers it, so the render reports it to the consumer's
 * `onError` ({@link recordRenderRedirect}).
 */

import { isRedirectResponse } from "../response-utils.js";

/**
 * The window a response has to answer a redirect its render reported. One per
 * render stage: the stage that starts the render creates it, the lane that
 * commits the response's status closes it.
 */
export interface RenderRedirectWindow {
  /** The first redirect the render reported while the window was open. */
  response?: Response;
  /** The status has committed: nothing will answer a redirect reported now. */
  closed: boolean;
}

/**
 * Open a window where a render starts. A lane that answers the response closes
 * it where its status commits; a render that owns no response (a shell capture,
 * a PPR shell HIT's tail) leaves it open, so a redirect it reports answers
 * nothing and is reported by nobody: the lane that owns that render's failure
 * reports it (a capture's refusal, a refused write).
 */
export function createRenderRedirectWindow(): RenderRedirectWindow {
  return { closed: false };
}

/**
 * Record the redirect a render reported, and say whether it is too late to
 * answer the response.
 *
 * True only for a redirect the render can no longer answer: the error row
 * React writes renders the boundary, so the caller reports it as a rendering
 * error. False for a redirect the response will answer, for one that arrives
 * after the response already answered another (first wins, like a handler's
 * redirect short-circuiting the render it started), and for anything that is
 * not a redirect.
 */
export function recordRenderRedirect(
  window: RenderRedirectWindow,
  error: unknown,
): boolean {
  if (!isRenderRedirect(error)) return false;
  if (window.response !== undefined) return false;
  if (window.closed) return true;
  window.response = error;
  return false;
}

/**
 * A value a render threw that is a redirect: the one control flow this module
 * answers. A thrown non-redirect `Response` (a 403, a 500) stays an error.
 */
export function isRenderRedirect(value: unknown): value is Response {
  return value instanceof Response && isRedirectResponse(value);
}

/**
 * Close the window: the response's status commits here. Throw the redirect the
 * render reported while it was open, so it lands in the lanes that already
 * answer a handler's throw (`rsc/handler.ts`): the partial conversion to 204 +
 * `X-RSC-Redirect`, the document 3xx through `finalizeRequestResponse`'s guard
 * and location-state cookie.
 */
export function closeRenderRedirectWindow(window: RenderRedirectWindow): void {
  window.closed = true;
  const redirect = window.response;
  if (redirect) throw redirect;
}

/**
 * Hold a Flight stream until its opening flush, then close the window (which
 * throws the redirect the render reported in it), or hand the stream back
 * unchanged in content.
 *
 * The opening flush is React's first `performWork` flush: the payload row and
 * every component that rendered synchronously, error rows included. A redirect
 * a synchronous component threw is in it; an async component's is not, and
 * arrives too late to answer.
 *
 * The first chunk is re-enqueued ahead of the rest, so the body the caller
 * builds carries the whole render. A stream that failed before its first flush
 * comes back as a stream that fails the same way: the response is built as it
 * was, and its body errors where it always did.
 */
export async function holdOpeningRedirect(
  window: RenderRedirectWindow,
  stream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const held = await peekOpeningChunk(stream);
  // Answered: the held stream is dropped unread. A Flight stream that nobody
  // pulls does not flow, so the render stops where it is (the same teardown a
  // handler's redirect gets by never starting it), and cancelling it instead
  // would report React's abort to the consumer's onError.
  closeRenderRedirectWindow(window);
  return held;
}

/**
 * {@link holdOpeningRedirect} without the redirect: await the opening flush and
 * hand the stream back with its first chunk in place. The SSR test stub uses
 * it to keep the window a real shell has (the shell reads the payload), so a
 * document served through it answers a component's redirect as production
 * does.
 */
export async function peekOpeningChunk(
  stream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader();
  let first: ReadableStreamReadResult<Uint8Array>;
  try {
    first = await reader.read();
  } catch (error) {
    return failedStream(error);
  }
  return prependChunk(reader, first);
}

function failedStream(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error);
    },
  });
}

/**
 * The peeked chunk followed by the reader's remainder, pulled on demand so the
 * render's backpressure is unchanged.
 */
function prependChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  first: ReadableStreamReadResult<Uint8Array>,
): ReadableStream<Uint8Array> {
  let done = false;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) {
        done = true;
        controller.close();
        return;
      }
      controller.enqueue(first.value);
    },
    async pull(controller) {
      if (done) return;
      try {
        const next = await reader.read();
        if (cancelled) return;
        if (next.done) {
          done = true;
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (cancelled) return;
        done = true;
        controller.error(error);
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    },
  });
}
