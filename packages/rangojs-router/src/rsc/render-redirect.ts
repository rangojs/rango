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
 * That window is:
 * - a Flight response (a client navigation, a prefetch): its opening flush,
 *   where a synchronous component's throw is already serialized
 *   ({@link holdOpeningRedirect});
 * - a document: its shell. Fizz reads the payload the shell needs, so a throw
 *   that failed the shell, and one the opening flush carried, are both known
 *   before the status commits (`createSsrHtmlStage`).
 *
 * A redirect reported after its window is out of time: an async component is a
 * task of its own, so its error row lands in a later chunk, and the response is
 * committed. Buffering the whole render to close that gap is what the streaming
 * contract forbids (docs/internal/execution-model.md, "A component that throws
 * redirect() redirects, if the render says so in time"), so that case keeps
 * rendering the boundary.
 */

import { isRedirectResponse } from "../response-utils.js";

/** The request-context fields this module reads and writes. */
interface RenderRedirectContext {
  _renderRedirect?: Response;
}

/**
 * Record the first redirect a render reported. The Flight `onError` calls this
 * with the thrown `Response` before React writes its error row, so a render
 * that says so in time has it before the status commits.
 *
 * First wins, like a handler's redirect short-circuiting the render it started:
 * a page that redirects answers the redirect whatever else the tree throws.
 */
export function recordRenderRedirect(
  context: RenderRedirectContext | undefined,
  error: unknown,
): void {
  if (!context || context._renderRedirect !== undefined) return;
  if (!isRenderRedirect(error)) return;
  context._renderRedirect = error;
}

/**
 * A value a render threw that is a redirect: the one control flow this module
 * answers. A thrown non-redirect `Response` (a 403, a 500) stays an error.
 */
export function isRenderRedirect(value: unknown): value is Response {
  return value instanceof Response && isRedirectResponse(value);
}

/**
 * Throw the redirect this render reported, if it did. Called where the status
 * commits, so the throw lands in the lanes that already answer a handler's
 * throw (`rsc/handler.ts`): the partial conversion to 204 + `X-RSC-Redirect`,
 * the document 3xx through `finalizeRequestResponse`'s guard and
 * location-state cookie.
 */
export function throwIfRenderRedirect(
  context: RenderRedirectContext | undefined,
): void {
  const redirect = context?._renderRedirect;
  if (redirect) throw redirect;
}

/**
 * Hold a Flight stream until its opening flush, then throw the redirect the
 * render reported in it, or hand the stream back unchanged in content.
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
  context: RenderRedirectContext | undefined,
  stream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const held = await peekOpeningChunk(stream);
  // Answered: the held stream is dropped unread. A Flight stream that nobody
  // pulls does not flow, so the render stops where it is (the same teardown a
  // handler's redirect gets by never starting it), and cancelling it instead
  // would report React's abort to the consumer's onError.
  throwIfRenderRedirect(context);
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
