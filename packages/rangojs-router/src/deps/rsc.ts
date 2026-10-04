/// <reference types="@vitejs/plugin-rsc/types" />
// Re-export the RSC-environment *server* runtime for virtual entries.
// Prefer `@vitejs/plugin-rsc/rsc/server` over the combined `/rsc` barrel so
// Vite can skip bundling the unused `react-server-dom` client protocol.
export {
  renderToReadableStream,
  decodeReply,
  createTemporaryReferenceSet,
  loadServerAction,
  decodeAction,
  decodeFormState,
} from "@vitejs/plugin-rsc/rsc/server";
