// Internal debug gate. Enable with INTERNAL_RANGO_DEBUG=1 in the environment.
// Only checked on the server (Node.js / Bun); on workers process is undefined.
export const INTERNAL_RANGO_DEBUG: boolean =
  typeof process !== "undefined" &&
  Boolean((process as any).env?.INTERNAL_RANGO_DEBUG);
