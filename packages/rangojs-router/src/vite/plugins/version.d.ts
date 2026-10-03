/**
 * Type declarations for rsc-router:version virtual module.
 * This module is provided by the Vite plugin at build/dev time.
 */

declare module "@rangojs/router:version" {
  /**
   * The build's version string.
   *
   * - Dev: a stamp that changes on server start and on every RSC module edit.
   * - Production: the whole-build document version, a hash of the server
   *   output and the client asset names. The same source builds to the same
   *   value; any change to any router changes it.
   *
   * A router serves with its own versions (`ROUTER_VERSIONS`), not this one.
   */
  export const VERSION: string;

  /**
   * Per-router cache versions computed at build time: router id to
   * `[data, document]`, with `"*"` holding the whole-build pair.
   * `undefined` in dev, where `VERSION` is used for both.
   */
  export const ROUTER_VERSIONS:
    | Readonly<Record<string, readonly [data: string, document: string]>>
    | undefined;
}
