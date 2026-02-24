// Internal debug gate. Enable with INTERNAL_RANGO_DEBUG=1 in the environment.
// Uses a Vite define (__RANGO_DEBUG__) for compile-time injection so it works
// in all runtimes including Cloudflare Workers where process.env is unavailable.
// Falls back to process.env for non-Vite contexts (tests, direct Node usage).
export const INTERNAL_RANGO_DEBUG: boolean =
  typeof __RANGO_DEBUG__ !== "undefined"
    ? __RANGO_DEBUG__
    : typeof process !== "undefined" &&
      Boolean((process as any).env?.INTERNAL_RANGO_DEBUG);

declare const __RANGO_DEBUG__: boolean;
