/**
 * Round-trip + parity tests for the chunked base64 helpers (C6).
 *
 * bufferToBase64 now encodes the latin1 string in fixed-size chunks via
 * String.fromCharCode.apply instead of one fromCharCode per byte. The output
 * must be byte-identical to the old per-byte implementation (so existing KV
 * document envelopes still decode) and must round-trip exactly for small,
 * large, and arbitrary-binary buffers.
 */

import { describe, it, expect } from "vitest";
import { bufferToBase64, base64ToBuffer } from "../cf-base64.js";

// Reference implementation: the original per-byte loop. Parity against this
// proves the chunked version produces identical output.
function refBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function makeBytes(n: number, fill: (i: number) => number): ArrayBuffer {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = fill(i) & 0xff;
  return a.buffer;
}

describe("cf-base64 chunked encode", () => {
  const cases: Array<[string, ArrayBuffer]> = [
    ["empty", new Uint8Array(0).buffer],
    ["single byte", makeBytes(1, () => 0xab)],
    ["small ascii", new TextEncoder().encode("Hello, World!").buffer],
    ["all byte values 0..255", makeBytes(256, (i) => i)],
    // Crosses the 8192 chunk boundary several times with a non-trivial pattern.
    [
      "large 100k pseudo-random",
      makeBytes(100_000, (i) => (i * 31 + 7) ^ (i >> 3)),
    ],
    // Exactly on the chunk boundary, and one past it.
    ["exactly one chunk (8192)", makeBytes(8192, (i) => i)],
    ["chunk + 1 (8193)", makeBytes(8193, (i) => i * 7)],
    ["high bytes only", makeBytes(5000, () => 0xff)],
  ];

  for (const [label, buf] of cases) {
    it(`matches the per-byte reference output: ${label}`, () => {
      expect(bufferToBase64(buf)).toBe(refBufferToBase64(buf));
    });

    it(`round-trips exactly: ${label}`, () => {
      const encoded = bufferToBase64(buf);
      const decoded = new Uint8Array(base64ToBuffer(encoded));
      expect(Array.from(decoded)).toEqual(Array.from(new Uint8Array(buf)));
    });
  }

  it("round-trips arbitrary binary with all 256 byte values repeated", () => {
    const buf = makeBytes(256 * 40, (i) => i % 256);
    const decoded = new Uint8Array(base64ToBuffer(bufferToBase64(buf)));
    expect(decoded).toEqual(new Uint8Array(buf));
  });
});
