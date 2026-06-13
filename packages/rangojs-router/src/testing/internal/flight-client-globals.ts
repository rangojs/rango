/**
 * Side-effect module: define the webpack-style globals the vendored
 * react-server-dom CLIENT deserializer reads at module-eval time.
 *
 * In a real app the plugin-rsc Vite plugin rewrites `__webpack_require__` ->
 * `__vite_rsc_require__` and `__webpack_require__.u` -> `({}).u`
 * (@vitejs/plugin-rsc `core/plugin.js`). That transform does NOT run in a bare
 * Vitest process, so the vendored client's free `__webpack_require__` /
 * `__webpack_chunk_load__` references would be undefined. We provide minimal
 * shims: `__webpack_require__` routes to the loader installed via
 * `setRequireModule`, and `__webpack_chunk_load__` is a no-op (renderServerTree
 * serializes with empty `chunks`, so no chunk fetch ever happens).
 *
 * MUST be imported (for side effect) BEFORE `@vitejs/plugin-rsc/react/browser`,
 * which is why flight-tree.ts lists it first.
 */
const g = globalThis as unknown as {
  __webpack_require__?: ((id: string) => unknown) & { u?: unknown };
  __webpack_chunk_load__?: (chunkId: string) => Promise<unknown>;
  __vite_rsc_client_require__?: (id: string) => unknown;
};

if (!g.__webpack_require__) {
  g.__webpack_require__ = (id: string) => g.__vite_rsc_client_require__!(id);
}
if (!g.__webpack_chunk_load__) {
  g.__webpack_chunk_load__ = async () => {};
}

export {};
