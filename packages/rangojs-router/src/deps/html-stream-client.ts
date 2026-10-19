// The document's Flight stream for the generated browser entry. Outside a
// browser it stays empty and open, as rsc-html-stream/client's did.
import {
  createDocumentFlightStream,
  type FlightDataHost,
} from "../browser/document-flight-stream.js";

export const rscStream: ReadableStream<Uint8Array> =
  typeof document === "undefined"
    ? new ReadableStream<Uint8Array>()
    : createDocumentFlightStream(document, self as FlightDataHost);
