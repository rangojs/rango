/**
 * Internal build-pipeline exports for @rangojs/router.
 *
 * These are implementation details of the route-trie compilation and client-ref
 * collection pipeline. They cross the build/runtime realm boundary and their
 * shapes (e.g. the compact {@link TrieNode}/{@link TrieLeaf} encoding) are not
 * stable public API — they may change between releases without notice.
 *
 * The documented public build API lives on `@rangojs/router/build`
 * (`generateManifest`, `generateManifestCode`, route-type generation, etc.).
 */

export {
  buildRouteTrie,
  buildPerRouterTrie,
  type TrieNode,
  type TrieLeaf,
} from "./route-trie.js";

export { collectFallbackClientRefs } from "./collect-fallback-refs.js";
