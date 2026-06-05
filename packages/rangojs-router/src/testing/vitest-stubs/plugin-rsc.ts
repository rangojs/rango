// Stub for `@vitejs/plugin-rsc/rsc`, shipped so consumers do not have to write a
// per-file `vi.mock(...)`. Importing a router internal transitively pulls this
// module, whose real top-level body imports Vite virtuals that do not resolve in
// plain node. The unit/integration primitives (dispatch/runLoader/runMiddleware)
// never render RSC, so empty fns suffice.
export const createFromReadableStream = (): never => {
  throw new Error("plugin-rsc stub: createFromReadableStream not available");
};
export const renderToReadableStream = (): never => {
  throw new Error("plugin-rsc stub: renderToReadableStream not available");
};
export const loadServerAction = (): undefined => undefined;
export const decodeReply = (): undefined => undefined;
export const decodeAction = (): undefined => undefined;
export const decodeFormState = (): undefined => undefined;
export const createTemporaryReferenceSet = (): Record<string, never> => ({});
