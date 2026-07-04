/**
 * C3: streamToString collects chunks in an array and joins once (was string
 * +=), while keeping the streaming TextDecoder semantics. These tests pin that
 * multi-chunk streams — including a multi-byte UTF-8 code point split across a
 * chunk boundary — decode identically.
 *
 * @vitejs/plugin-rsc/rsc is a virtual module unresolvable in the unit runner;
 * it is mocked only so segment-codec.ts can be imported (streamToString itself
 * uses none of it).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  renderToReadableStream: vi.fn(),
  createTemporaryReferenceSet: vi.fn(),
  createFromReadableStream: vi.fn(),
}));

import { streamToString } from "../segment-codec.js";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

describe("streamToString (C3)", () => {
  it("decodes a single chunk", async () => {
    const bytes = new TextEncoder().encode("hello world");
    expect(await streamToString(streamOf([bytes]))).toBe("hello world");
  });

  it("joins multiple chunks in order", async () => {
    const enc = new TextEncoder();
    const chunks = ["foo", "bar", "baz"].map((s) => enc.encode(s));
    expect(await streamToString(streamOf(chunks))).toBe("foobarbaz");
  });

  it("returns an empty string for an empty stream", async () => {
    expect(await streamToString(streamOf([]))).toBe("");
  });

  it("decodes a multi-byte UTF-8 char split across a chunk boundary", async () => {
    // "€" is 0xE2 0x82 0xAC. Split it so the decoder must carry state across
    // reads (the {stream:true} semantics that array-join must preserve).
    const chunks = [
      new Uint8Array([0xe2]),
      new Uint8Array([0x82, 0xac]),
      new TextEncoder().encode("!"),
    ];
    expect(await streamToString(streamOf(chunks))).toBe("€!");
  });
});
