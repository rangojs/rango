/**
 * Nonce generation for Content Security Policy (CSP)
 */

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
