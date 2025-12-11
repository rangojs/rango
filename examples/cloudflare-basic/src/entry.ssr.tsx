import { createSSRHandler, PassthroughDocument } from "rsc-router/ssr";
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import { renderToReadableStream } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-html-stream/server";

// Using PassthroughDocument because the RSC HtmlShell component
// handles the full HTML shell (<html>, <head>, <body>, <div id="root">)
export const { renderHTML } = createSSRHandler({
  deps: { createFromReadableStream },
  renderToReadableStream,
  injectRSCPayload,
  Document: PassthroughDocument,
});
