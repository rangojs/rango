import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-html-stream/server";
import type { RscPayload } from "./entry.rsc.js";

/**
 * SSR Entry - Converts RSC stream to HTML
 */
export async function renderHTML(
  rscStream: ReadableStream<Uint8Array>
): Promise<ReadableStream<Uint8Array>> {
  console.log("[SSR] Rendering HTML");

  // Tee the stream:
  // - rscStream1: For SSR rendering (deserialize to React VDOM)
  // - rscStream2: For browser hydration (inject as __FLIGHT_DATA__)
  const [rscStream1, rscStream2] = rscStream.tee();

  // Deserialize RSC stream to React tree
  let payload: Promise<RscPayload> | undefined;
  function SsrRoot() {
    // Kick off deserialization inside ReactDOMServer context
    payload ??= createFromReadableStream<RscPayload>(rscStream1);
    return <FixSsrThenable>{React.use(payload).root}</FixSsrThenable>;
  }

  // Wrapper component to avoid React SSR bugs with lazy + use
  function FixSsrThenable(props: React.PropsWithChildren) {
    return props.children;
  }

  // Get bootstrap script content (loads entry.browser.tsx)
  const bootstrapScriptContent =
    await import.meta.viteRsc.loadBootstrapScriptContent("index");

  // Render React tree to HTML stream
  const htmlStream = await renderToReadableStream(<SsrRoot />, {
    bootstrapScriptContent,
  });

  // Inject RSC payload into HTML as <script>__FLIGHT_DATA__</script>
  const responseStream = htmlStream.pipeThrough(injectRSCPayload(rscStream2));

  console.log("[SSR] ✓ HTML stream ready");
  return responseStream;
}
