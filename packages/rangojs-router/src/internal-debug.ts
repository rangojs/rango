// Vite define for compile-time injection; falls back to process.env (tests, Node).
// Works in all runtimes including Cloudflare Workers where process.env is unavailable.
export const INTERNAL_RANGO_DEBUG: boolean =
  typeof __RANGO_DEBUG__ !== "undefined"
    ? __RANGO_DEBUG__
    : typeof process !== "undefined" &&
      Boolean((process as any).env?.INTERNAL_RANGO_DEBUG);

declare const __RANGO_DEBUG__: boolean;
