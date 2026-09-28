/**
 * Round-trip + parity tests for the chunked base64 helpers (C6).
 *
 * bufferToBase64 now encodes the latin1 string in fixed-size chunks via
 * String.fromCharCode.apply instead of one fromCharCode per byte. The output
 * must be byte-identical to the old per-byte implementation (so existing KV
 * document envelopes still decode) and must round-trip exactly for small,
 * large, and arbitrary-binary buffers.
 */

import { describe, it, expect, vi } from "vitest";
import {
  base64ByteLength,
  bufferToBase64,
  base64ToBuffer,
  base64ToBytes,
} from "../cf-base64.js";
import { installNativeBase64 } from "./native-base64.js";

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

// The TC39 Uint8Array base64 methods (workerd) replace the per-byte loop when
// present. Node 22/24 have neither, so install Buffer-backed stand-ins; the
// module looks them up per call.
describe("cf-base64 native Uint8Array methods", () => {
  it("uses fromBase64/toBase64 when present, with output identical to the loop", () => {
    const fromBase64 = vi.fn(
      (b64: string) => new Uint8Array(Buffer.from(b64, "base64")),
    );
    const toBase64 = vi.fn(function (this: Uint8Array) {
      return Buffer.from(this).toString("base64");
    });
    const restore = installNativeBase64(fromBase64, toBase64);
    try {
      const buf = makeBytes(100_000, (i) => (i * 31 + 7) ^ (i >> 3));
      const encoded = bufferToBase64(buf);
      expect(encoded).toBe(refBufferToBase64(buf));
      expect(new Uint8Array(base64ToBuffer(encoded))).toEqual(
        new Uint8Array(buf),
      );
      expect(base64ToBytes(encoded)).toEqual(new Uint8Array(buf));
      expect(toBase64).toHaveBeenCalledTimes(1);
      expect(fromBase64).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it("throws on a character outside the alphabet (the corrupt-entry signal)", () => {
    expect(() => base64ToBytes("%%%not-base64%%%")).toThrow();
  });
});

describe("base64ByteLength", () => {
  it("is the decoded length, padded or not", () => {
    for (let n = 0; n <= 9; n++) {
      const encoded = bufferToBase64(makeBytes(n, (i) => i * 17));
      expect(base64ByteLength(encoded)).toBe(n);
      expect(base64ByteLength(encoded.replace(/=+$/, ""))).toBe(n);
    }
  });
});
