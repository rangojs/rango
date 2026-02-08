/**
 * Type declarations for the virtual:rsc-router/prerender-paths virtual module.
 * This module is provided by the Vite plugin at build/dev time.
 */

declare module "virtual:rsc-router/prerender-paths" {
  /**
   * Array of URL paths that were pre-rendered at build time.
   * Empty in dev mode. In production, contains paths like ["/articles", "/articles/my-post"].
   */
  const prerenderPaths: string[];
  export default prerenderPaths;
}
