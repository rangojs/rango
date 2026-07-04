/**
 * Nonce generation for Content Security Policy (CSP)
 */

import type { ContextVar } from "../context-var.js";
import { createVar } from "../context-var.js";

/**
 * Typed ContextVar token for CSP nonce.
 *
 * Use this to READ the nonce in middleware or handlers:
 * ```ts
 * import { nonce } from "@rangojs/router";
 * const value = ctx.get(nonce); // string | undefined
 * ```
 *
 * Supply the nonce via the `createRouter({ nonce })` provider, not by writing
 * this token yourself. The provider value is threaded into the router's SSR
 * machinery (NonceContext/useNonce, Scripts/MetaTags attributes, the inlined
 * Flight payload scripts) AND sets this token. A direct `ctx.set(nonce, value)`
 * in middleware runs AFTER the SSR nonce is resolved: the value is readable via
 * `ctx.get(nonce)` and gates PPR shell capture (a per-request nonce must never
 * bake into a shared shell), but the router will not apply it to its own
 * scripts — useNonce() stays undefined for that request.
 */
export const nonce: ContextVar<string> = createVar<string>();

/**
 * Generate a cryptographic nonce for CSP.
 * Returns a 16-byte random value encoded as base64.
 */
export function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  // Convert to base64
  let binary = "";
  for (let i = 0; i < array.length; i++) {
    binary += String.fromCharCode(array[i]);
  }
  return btoa(binary);
}
