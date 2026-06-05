/**
 * Ambient declaration for the vendored react-server-dom serializer shipped
 * inside @vitejs/plugin-rsc. The package ships no .d.ts for this private
 * subpath, so we declare the minimal surface renderToFlightString uses.
 *
 * Only loadable under the `react-server` export condition (see flight.ts).
 */
declare module "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge" {
  /**
   * Serialize a server-component payload to a Flight wire stream.
   *
   * @param payload The value to serialize (Rango wraps a payload object).
   * @param clientManifest Client-reference manifest; `{}` for server-only trees.
   * @param options Render options; `onError` is invoked per render error.
   */
  export function renderToReadableStream(
    payload: unknown,
    clientManifest: unknown,
    options?: { onError?: (error: unknown) => string | void },
  ): ReadableStream<Uint8Array>;
}
