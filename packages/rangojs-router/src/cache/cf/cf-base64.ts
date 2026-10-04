// ============================================================================
// Base64 Helpers (binary-safe response body encoding for KV)
// ============================================================================

// Chunk size for String.fromCharCode.apply: large enough to amortize the call
// overhead, small enough to stay well under the JS engine argument-count limit
// (~65k). 8192 turns a per-byte concat loop into O(n/8192) apply calls.
const FROM_CHARCODE_CHUNK = 8192;

/**
 * TC39 Uint8Array base64 methods (workerd, V8 >= 14; not Node 22/24). Same
 * alphabet, padding, and invalid-character throw as btoa/atob, and about 15x
 * faster than the per-byte loop on a 629 KB PPR prelude in workerd (0.05 ms vs
 * 0.75 ms, issue #941). Looked up per call, not captured at import, so a
 * polyfill or test spy installed later is the one that runs.
 */
type NativeUint8ArrayBase64 = {
  fromBase64?: (b64: string) => Uint8Array;
  prototype: { toBase64?: (this: Uint8Array) => string };
};
const NativeUint8Array = Uint8Array as unknown as NativeUint8ArrayBase64;

/** Encode ArrayBuffer to base64 string. */
export function bufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

/** Encode bytes (a view's own region only) to a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  const nativeToBase64 = NativeUint8Array.prototype.toBase64;
  if (nativeToBase64) return nativeToBase64.call(bytes);
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

/** Decode a base64 string to bytes. Throws on a character outside the alphabet. */
export function base64ToBytes(base64: string): Uint8Array {
  if (NativeUint8Array.fromBase64) return NativeUint8Array.fromBase64(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** The byte length `base64` decodes to (padded or not), without decoding. */
export function base64ByteLength(base64: string): number {
  let length = base64.length;
  while (length > 0 && base64.charCodeAt(length - 1) === 61 /* = */) length--;
  return Math.floor((length * 3) / 4);
}

/** Decode base64 string to ArrayBuffer. */
export function base64ToBuffer(base64: string): ArrayBuffer {
  return base64ToBytes(base64).buffer as ArrayBuffer;
}
