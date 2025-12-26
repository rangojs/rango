/// <reference types="@vitejs/plugin-rsc/types" />
// Re-export @vitejs/plugin-rsc/rsc for internal use by virtual entries
export {
  renderToReadableStream,
  decodeReply,
  createTemporaryReferenceSet,
  loadServerAction,
} from "@vitejs/plugin-rsc/rsc";
