/**
 * Nonce generation for Content Security Policy (CSP)
 */

import type { ContextVar } from "../context-var.js";
import { createVar } from "../context-var.js";

/**
 * Typed ContextVar token for CSP nonce.
 *
 * Use this to access the nonce in middleware or handlers:
 * ```ts
 * import { nonce } from "@rangojs/router";
 * const value = ctx.get(nonce); // string | undefined
 * ```
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
