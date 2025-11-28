import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-html-stream/server";
import type { RscPayload } from "./entry.rsc.js";

// SSR Entry - Converts RSC stream to HTML
export async function renderHTML(
  rscStream: ReadableStream<Uint8Array>
): Promise<ReadableStream<Uint8Array>> {
  // Tee the stream:
  // - rscStream1: For SSR rendering
  // - rscStream2: For browser hydration (injected as __FLIGHT_DATA__)
  const [rscStream1, rscStream2] = rscStream.tee();

  // Deserialize RSC stream to React tree
  let payload: Promise<RscPayload> | undefined;
  function SsrRoot() {
    payload ??= createFromReadableStream<RscPayload>(rscStream1);
    return React.use(payload).root;
  }

  // Get bootstrap script
  const bootstrapScriptContent =
    await import.meta.viteRsc.loadBootstrapScriptContent("index");

  // Render React tree to HTML stream
  const htmlStream = await renderToReadableStream(<SsrRoot />, {
    bootstrapScriptContent,
  });

  // Inject RSC payload into HTML for hydration
  const responseStream = htmlStream.pipeThrough(injectRSCPayload(rscStream2));

  return responseStream;
}
