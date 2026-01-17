import { createFromReadableStream } from "rsc-router/internal/deps/ssr";
import { renderToReadableStream } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-router/internal/deps/html-stream-server";
import { createSSRHandler } from "rsc-router/ssr";

// Export all SSR functions including renderShell for shell caching
export const { renderHTML, renderShell } = createSSRHandler({
  createFromReadableStream,
  renderToReadableStream,
  injectRSCPayload,
  loadBootstrapScriptContent: () =>
    import.meta.viteRsc.loadBootstrapScriptContent("index"),
});

// Re-export injectRSCPayload for use with cached shells
export { injectRSCPayload };
