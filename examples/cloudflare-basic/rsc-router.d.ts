// Type declarations for rsc-router virtual modules
declare module "rsc-router:version" {
  /**
   * Version string that changes on each server restart in dev mode.
   * Use this to invalidate cached RSC payloads when code changes.
   */
  export const VERSION: string;
}
