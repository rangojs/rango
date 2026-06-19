// ============================================================================
// Base64 Helpers (binary-safe response body encoding for KV)
// ============================================================================

// Chunk size for String.fromCharCode.apply: large enough to amortize the call
// overhead, small enough to stay well under the JS engine argument-count limit
// (~65k). 8192 turns a per-byte concat loop into O(n/8192) apply calls.
const FROM_CHARCODE_CHUNK = 8192;

/** Encode ArrayBuffer to base64 string. */
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // Build the binary (latin1) string in fixed-size chunks instead of one
  // String.fromCharCode per byte. Identical output to the per-byte loop (each
  // byte maps to the same code unit); just far fewer string concatenations for
  // large document payloads.
  let binary = "";
  for (let i = 0; i < bytes.length; i += FROM_CHARCODE_CHUNK) {
    const chunk = bytes.subarray(i, i + FROM_CHARCODE_CHUNK);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/** Decode base64 string to ArrayBuffer. */
export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
