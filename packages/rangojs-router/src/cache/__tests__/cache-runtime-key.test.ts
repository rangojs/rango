/**
 * Regression test for the "use cache" key derivation (C1).
 *
 * When a key arg is a typed array / Blob / File (or any value React lazily
 * chunks), encodeReply returns FormData whose multipart body embeds a per-call
 * RANDOM boundary. The old replyToCacheKey stringified the whole body via
 * `new Response(formData).text()`, so two identical arg sets produced DIFFERENT
 * keys on every call -> perpetual cache miss + unbounded store growth.
 *
 * The fix derives the key from the FormData entries (sorted-key order, bytes
 * hashed) so it is independent of the boundary. These tests feed real FormData
 * (built with the global FormData/Blob) directly into replyToCacheKey, which is
 * the exact locus of the bug; the virtual @vitejs/plugin-rsc/rsc module is
 * mocked only so cache-runtime.ts can be imported.
 */

import { describe, it, expect, vi } from "vitest";

// @vitejs/plugin-rsc/rsc is a virtual module, not resolvable in vitest. The
// key-derivation tests do not invoke encodeReply, but the import must resolve.
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  encodeReply: vi.fn(),
  createClientTemporaryReferenceSet: vi.fn(),
}));

import { replyToCacheKey } from "../cache-runtime.js";

function makeFormData(): FormData {
  const fd = new FormData();
  // Mirror the shape encodeReply emits for a Uint8Array + string arg set.
  fd.append("0", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "" }));
  fd.append("1", "hello");
  return fd;
}

describe("replyToCacheKey (use cache key derivation)", () => {
  it("returns a plain string verbatim", async () => {
    expect(await replyToCacheKey('["a",1]')).toBe('["a",1]');
  });

  it("produces the SAME key for two identical FormData arg sets", async () => {
    const a = await replyToCacheKey(makeFormData());
    const b = await replyToCacheKey(makeFormData());
    expect(a).toBe(b);
  });

  it("does NOT embed a multipart boundary in the key", async () => {
    const key = await replyToCacheKey(makeFormData());
    expect(key).not.toContain("formdata-undici");
    expect(key).not.toContain("Content-Disposition");
  });

  it("produces DIFFERENT keys for different byte payloads", async () => {
    const fd1 = new FormData();
    fd1.append("0", new Blob([new Uint8Array([1, 2, 3])], { type: "" }));
    const fd2 = new FormData();
    fd2.append("0", new Blob([new Uint8Array([9, 9, 9])], { type: "" }));
    expect(await replyToCacheKey(fd1)).not.toBe(await replyToCacheKey(fd2));
  });

  it("produces DIFFERENT keys for different string values", async () => {
    const fd1 = new FormData();
    fd1.append("0", "x");
    const fd2 = new FormData();
    fd2.append("0", "y");
    expect(await replyToCacheKey(fd1)).not.toBe(await replyToCacheKey(fd2));
  });

  it("is stable regardless of FormData entry insertion order", async () => {
    const fd1 = new FormData();
    fd1.append("a", "1");
    fd1.append("b", "2");
    const fd2 = new FormData();
    fd2.append("b", "2");
    fd2.append("a", "1");
    expect(await replyToCacheKey(fd1)).toBe(await replyToCacheKey(fd2));
  });
});
