import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-html-stream/server";
import {
  SSRHandleContext,
  type SSRHandleContextValue,
} from "rsc-router/browser";
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
  let ssrHandleContext: SSRHandleContextValue | null = null;

  function SsrRoot() {
    // Kick off deserialization inside ReactDOMServer context
    payload ??= createFromReadableStream<RscPayload>(rscStream1);
    const p = React.use(payload);

    // Get handle data for SSR context
    // Handles are always a Promise - use React.use() to suspend and wait
    if (p.metadata?.handles && !ssrHandleContext) {
      const handles = React.use(p.metadata.handles);
      const matchedSegmentIds =
        p.metadata.matched ?? p.metadata.segments.map((s) => s.id);
      ssrHandleContext = {
        handleEntries: handles,
        matchedSegmentIds,
      };
    }

    // Wrap root in SSRHandleContext so useHandle can access handle data during SSR
    if (ssrHandleContext) {
      return (
        <SSRHandleContext.Provider value={ssrHandleContext}>
          {p.root}
        </SSRHandleContext.Provider>
      );
    }

    return p.root;
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
