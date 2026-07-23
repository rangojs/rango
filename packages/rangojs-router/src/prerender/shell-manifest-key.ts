/**
 * Build shell manifest key, shared by the producer (the build's shell
 * prerender phase, vite/discovery/shell-prerender-phase.ts) and the consumer
 * (the runtime read-through, rsc/shell-build-manifest.ts) so the format
 * cannot drift. Dependency-free: the producer runs node-side in the plugin,
 * the consumer in the RSC runtime.
 *
 * PATHNAME-ONLY by design. Host-free because the build knows no request
 * host. Router-free because the router id ($$id) is a hash of
 * filePath:lineNumber of the TRANSFORMED source, which differs between the
 * discovery temp server's dev-style transform chain and the main build's —
 * a temp-realm router id can never be looked up by the shipped worker. The
 * producer instead detects pathname collisions across routers at build time
 * and declines both entries (loudly), keeping the key unambiguous. This is
 * a manifest namespace, never a store keyspace: the runtime shell key
 * (host + pathname + search + ":shell") stays untouched.
 */
export function buildShellManifestKey(pathname: string): string {
  return pathname;
}
