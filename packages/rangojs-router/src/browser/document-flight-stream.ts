type FlightChunk = string | Uint8Array;

/** Where the document's inline scripts push Flight chunks (`self`). */
export interface FlightDataHost {
  __FLIGHT_DATA?: FlightChunk[];
}

/**
 * The document's Flight payload as a stream: the server's inline scripts push
 * chunks onto `self.__FLIGHT_DATA` (rsc-html-stream/server, or
 * ssr/inject-rsc-eager.ts), and the browser's own DOMContentLoaded
 * (`isTrusted`) closes it after the last of them ran. rsc-html-stream/client
 * closed on any DOMContentLoaded, so a script re-dispatching the event cut a
 * streaming page short and threw after the load (#1205).
 */
export function createDocumentFlightStream(
  doc: Pick<
    Document,
    "readyState" | "addEventListener" | "removeEventListener"
  >,
  host: FlightDataHost,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const enqueue = (chunk: FlightChunk): void => {
    controller.enqueue(
      typeof chunk === "string" ? encoder.encode(chunk) : chunk,
    );
  };
  const data = (host.__FLIGHT_DATA ||= []);
  data.forEach(enqueue);
  data.push = (...chunks: FlightChunk[]): number => {
    chunks.forEach(enqueue);
    return data.length;
  };

  if (doc.readyState !== "loading") {
    controller.close();
  } else {
    const onLoaded = (event: Event): void => {
      if (!event.isTrusted) return;
      doc.removeEventListener("DOMContentLoaded", onLoaded);
      controller.close();
    };
    doc.addEventListener("DOMContentLoaded", onLoaded);
  }
  return stream;
}
