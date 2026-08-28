/// <reference types="@vitejs/plugin-rsc/types" />
// RSC-environment *client* protocol (deserialize / encodeReply). Kept as its
// own module so a server-only importer of `./rsc.ts` does not pull this side.
export {
  createFromReadableStream,
  encodeReply,
  createClientTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc/client";
