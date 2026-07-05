import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";

/**
 * Eager Flight-payload injector for the PPR resume path.
 *
 * rsc-html-stream's injectRSCPayload starts forwarding Flight chunks only from
 * inside its first transform() callback — i.e. AFTER the first HTML chunk flows.
 * That policy exists for the normal document path (a <script> must not precede
 * the doctype). On a PPR shell HIT it parks the ENTIRE hydration payload: the
 * resumed fizz render emits its first chunk only when the first hole's data
 * resolves (live loaders — measured ~1.5s on SFCC-backed pages), while the
 * Flight root row is ready within ~30ms of the tail render starting. The client
 * cannot call hydrateRoot until that root row arrives, so the lazy start held
 * hydration hostage to the slowest loader for no structural reason: the stored
 * prelude (a complete document through </body></html>) is already on the wire
 * before the tail, so every tail byte is foster-parented and a Flight <script>
 * is valid as the FIRST tail byte.
 *
 * This injector starts pumping Flight chunks immediately in start(). Ordering
 * safety is kept by serializing ALL writes through one promise chain: fizz
 * chunks buffered within a tick flush as one atomic task (same batching idea as
 * the stock injector — never inject between two partial HTML chunks), and each
 * Flight script is its own task, so scripts land only between batches. The
 * trailer is stripped from passing HTML and re-appended once, after both
 * streams complete — identical to the stock contract.
 *
 * RESUME/DATA-VARIANT ONLY. The normal document path must keep the stock
 * injector: there the first bytes are the document head, and an eager script
 * would precede the doctype.
 */

const encoder = new TextEncoder();
const TRAILER = "</body></html>";

// Escape closing script tags and HTML comments in JS content (ported from
// rsc-html-stream/server; escapes the "s" instead of the slash so a regexp
// literal like `0</script/` stays valid JS).
function escapeScript(script: string): string {
  return script.replace(/<!--/g, "<\\!--").replace(/<\/(script)/gi, "</\\$1");
}

function writeScript(
  controller: TransformStreamDefaultController<Uint8Array>,
  jsExpr: string,
  nonce: string | undefined,
): void {
  controller.enqueue(
    encoder.encode(
      `<script${nonce ? ` nonce="${nonce}"` : ""}>${escapeScript(
        `(self.__FLIGHT_DATA||=[]).push(${jsExpr})`,
      )}</script>`,
    ),
  );
}

export function injectRSCPayloadEager(
  rscStream: ReadableStream<Uint8Array>,
  options?: { nonce?: string },
): TransformStream<Uint8Array, Uint8Array> {
  const nonce = options?.nonce;
  const htmlDecoder = new TextDecoder();
  const t0 = INTERNAL_RANGO_DEBUG ? performance.now() : 0;
  let loggedFirstFlight = false;
  let loggedFirstHtml = false;

  // All output goes through this chain: one task per Flight script, one task
  // per buffered-HTML batch. A script can therefore never split a batch.
  let queue: Promise<void> = Promise.resolve();
  const enqueueTask = (fn: () => void): Promise<void> => {
    queue = queue.then(fn);
    return queue;
  };

  let buffered: Uint8Array[] = [];
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let rscDone: Promise<void> = Promise.resolve();

  function flushBufferedHTML(
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    if (INTERNAL_RANGO_DEBUG && !loggedFirstHtml && buffered.length > 0) {
      loggedFirstHtml = true;
      console.log(
        `[Server][ppr] eager-inject: first resumed HTML batch +${Math.round(performance.now() - t0)}ms`,
      );
    }
    for (const chunk of buffered) {
      let buf = htmlDecoder.decode(chunk, { stream: true });
      if (buf.endsWith(TRAILER)) buf = buf.slice(0, -TRAILER.length);
      controller.enqueue(encoder.encode(buf));
    }
    const remaining = htmlDecoder.decode();
    if (remaining.length) {
      const out = remaining.endsWith(TRAILER)
        ? remaining.slice(0, -TRAILER.length)
        : remaining;
      controller.enqueue(encoder.encode(out));
    }
    buffered.length = 0;
    timeout = null;
  }

  async function pumpRSC(
    controller: TransformStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    const rscDecoder = new TextDecoder("utf-8", { fatal: true });
    const reader = rscStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // String when the chunk is valid unicode, base64 round-trip otherwise —
      // same fallback the stock injector uses.
      let jsExpr: string;
      try {
        jsExpr = JSON.stringify(rscDecoder.decode(value, { stream: true }));
      } catch {
        const base64 = JSON.stringify(
          btoa(String.fromCodePoint(...(value as Uint8Array))),
        );
        jsExpr = `Uint8Array.from(atob(${base64}), m => m.codePointAt(0))`;
      }
      await enqueueTask(() => {
        if (INTERNAL_RANGO_DEBUG && !loggedFirstFlight) {
          loggedFirstFlight = true;
          console.log(
            `[Server][ppr] eager-inject: first flight script +${Math.round(performance.now() - t0)}ms`,
          );
        }
        writeScript(controller, jsExpr, nonce);
      });
    }
    const remaining = rscDecoder.decode();
    if (remaining.length) {
      await enqueueTask(() =>
        writeScript(controller, JSON.stringify(remaining), nonce),
      );
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      // The eager part: pump Flight immediately, before any HTML arrives.
      rscDone = pumpRSC(controller).catch((err) => {
        try {
          controller.error(err);
        } catch {
          // Stream already errored/closed; nothing to signal.
        }
      });
    },
    transform(chunk, controller) {
      buffered.push(chunk);
      if (timeout) return;
      // Batch same-tick fizz chunks so a Flight script cannot land between two
      // partial HTML chunks of one logical write (stock injector's invariant).
      timeout = setTimeout(() => {
        void enqueueTask(() => flushBufferedHTML(controller));
      }, 0);
    },
    async flush(controller) {
      await rscDone;
      if (timeout) clearTimeout(timeout);
      await enqueueTask(() => flushBufferedHTML(controller));
      controller.enqueue(encoder.encode(TRAILER));
    },
  });
}
