import { AsyncLocalStorage } from "node:async_hooks";
import { preinitModule } from "react-dom";

/**
 * JS/CSS asset deps plugin-rsc resolves for a client reference. Structural
 * mirror of @vitejs/plugin-rsc's ResolvedAssetDeps — deliberately not imported:
 * @rangojs/router/ssr never imports plugin-rsc directly; every plugin binding
 * is injected by the virtual SSR entry (see SSRDependencies).
 */
export interface ClientReferenceDeps {
  js: string[];
  css: string[];
}

/**
 * Callback shape of @vitejs/plugin-rsc/ssr's setOnClientReference. Fired
 * (synchronously, inside the Fizz render) whenever a client reference module
 * is accessed during SSR — the same moment plugin-rsc issues its own
 * ReactDOM.preloadModule calls for the reference's chunks.
 */
export type OnClientReference = (reference: {
  id: string;
  deps: ClientReferenceDeps;
}) => void;

/** setOnClientReference from @vitejs/plugin-rsc/ssr (injected). */
export type SetOnClientReference = (
  callback: OnClientReference | undefined,
) => void;

/**
 * Per-request CSP nonce channel for the preinit hook. The hook is installed
 * once per isolate while the nonce is per request, and Fizz interleaves
 * concurrent renders at task granularity — a module-scoped variable would race
 * across requests and stamp request A's scripts with request B's nonce. ALS is
 * the only channel that survives from the render call into the client-reference
 * proxy access. A lost context degrades to nonce-less preinit (CSP blocks the
 * head script; hydration still works through the nonce'd bootstrap), never to a
 * wrong nonce.
 */
const preinitNonceStorage = new AsyncLocalStorage<string | undefined>();

/**
 * Run a Fizz render (renderToReadableStream / prerender / resume) with the
 * request's nonce visible to the client-reference preinit hook. Nonce-less
 * requests (the common non-CSP configuration) skip the ALS frame entirely —
 * getStore() on an unentered storage already returns undefined, so the hook
 * reads the same value either way.
 */
export function runWithPreinitNonce<T>(
  nonce: string | undefined,
  fn: () => T,
): T {
  return nonce === undefined ? fn() : preinitNonceStorage.run(nonce, fn);
}

/**
 * Upgrade plugin-rsc's client-reference modulepreload hints to executing
 * scripts: for every JS chunk a client reference needs, emit
 * `<script type="module" src async>` hoisted into the document head instead of
 * only `<link rel="modulepreload">`.
 *
 * Why: modulepreload fetches + compiles but never executes; the chunks then
 * execute only when the entry's hydration import walks the graph — after the
 * whole document has streamed. preinitModule starts execution as soon as each
 * chunk arrives, overlapping it with body streaming (the pattern Next.js uses
 * via ReactDOM.preinit for all non-bootstrap chunks). Under PPR the preinits
 * run during shell capture, so the executing tags live in the stored prelude
 * and chunk execution starts on the first flushed bytes.
 *
 * No duplicate tags: plugin-rsc's preloadModule fires first in the same
 * synchronous block; Fizz's preinitModuleScript then clears the queued preload
 * chunks for that URL and adopts its credentials (ReactFizzConfigDOM,
 * renderState.preloads.moduleScripts). Capture→resume double-emission is
 * prevented the same way: the `moduleScriptResources[src] = null` markers
 * serialize inside the postponed state, so the resume pass preinits only
 * references the shell never saw.
 *
 * crossOrigin "" matches plugin-rsc's preloadModule creds so the upgrade path
 * reuses the same resource instead of forking on credential mismatch.
 *
 * Known trades (deliberate, measured neutral-to-positive on the e2e apps —
 * PR #694 has the Lighthouse/hydration numbers):
 * - Fetch priority: an executing async module script fetches at Chromium's
 *   async-script priority, below a bare modulepreload hint; preinitModule
 *   forwards no fetchPriority (react-dom's public API drops it — only
 *   `preinit` forwards it). Execution-overlap is bought with hint priority,
 *   the same trade Next.js ships via ReactDOM.preinit.
 * - Build only: plugin-rsc's dev load path reports `js: []` per reference, so
 *   dev documents have no head chunk scripts — a client module whose module
 *   scope assumes body-parsed DOM can break in production only. The
 *   `rango({ headScripts: "preload" })` escape hatch restores hint-only.
 * - plugin-rsc's setOnClientReference is a single-slot, last-write-wins
 *   setter: another registrant in the SSR environment silently replaces this
 *   hook (or is replaced by it). No composition API exists upstream yet.
 */
export function installClientReferencePreinit(
  setOnClientReference: SetOnClientReference,
): void {
  setOnClientReference(({ deps }) => {
    const nonce = preinitNonceStorage.getStore();
    for (const href of deps.js) {
      preinitModule(href, { as: "script", crossOrigin: "", nonce });
    }
  });
}
