/**
 * A plain server-module function: not a "use client" export, so passing it
 * as transition({ when }) fails route discovery (router.tsx).
 */
export function serverWhen(): boolean {
  return true;
}
