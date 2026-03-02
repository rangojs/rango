/**
 * Tests for serializeResult/deserializeResult from segment-codec.ts.
 *
 * These test the null-preserving RSC Flight serialization used by loader
 * caching and "use cache". The mock below simulates the RSC Flight protocol
 * using JSON as the transport — critically, it does NOT skip null/undefined,
 * matching real RSC behavior where null is a valid serializable value.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@vitejs/plugin-rsc/rsc", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    renderToReadableStream(value: unknown) {
      // RSC Flight serializes any value including null
      const bytes = encoder.encode(JSON.stringify(value));
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    createFromReadableStream<T>(
      stream: ReadableStream<Uint8Array>,
    ): Promise<T> {
      return new Response(stream).text().then((t) => JSON.parse(t) as T);
    },
    createTemporaryReferenceSet() {
      return new Set();
    },
  };
});

// Import AFTER mock registration so the real module picks up the mock
const { serializeResult, deserializeResult, rscSerialize, rscDeserialize } =
  await import("../cache/segment-codec");

describe("segment-codec result serialization", () => {
  describe("serializeResult (null-preserving)", () => {
    it("serializes objects", async () => {
      const result = await serializeResult({ name: "test", count: 42 });
      expect(result).not.toBeNull();
      expect(typeof result).toBe("string");
    });

    it("serializes null (does NOT return null)", async () => {
      const result = await serializeResult(null);
      // serializeResult passes null to renderToReadableStream which serializes it
      expect(result).not.toBeNull();
      expect(typeof result).toBe("string");
    });

    it("serializes undefined", async () => {
      const result = await serializeResult(undefined);
      // undefined is also a valid RSC-serializable value
      expect(result).not.toBeNull();
      expect(typeof result).toBe("string");
    });

    it("returns null on serialization failure", async () => {
      // renderToReadableStream can throw for non-serializable values
      // Our mock uses JSON.stringify which throws on circular refs
      const circular: any = {};
      circular.self = circular;
      const result = await serializeResult(circular);
      expect(result).toBeNull();
    });

    it("round-trips null through serialize/deserialize", async () => {
      const serialized = await serializeResult(null);
      expect(serialized).not.toBeNull();
      const deserialized = await deserializeResult(serialized!);
      expect(deserialized).toBeNull();
    });

    it("round-trips objects through serialize/deserialize", async () => {
      const original = { name: "product", price: 29.99, inStock: true };
      const serialized = await serializeResult(original);
      expect(serialized).not.toBeNull();
      const deserialized = await deserializeResult(serialized!);
      expect(deserialized).toEqual(original);
    });

    it("round-trips arrays through serialize/deserialize", async () => {
      const original = [1, "two", null, { nested: true }];
      const serialized = await serializeResult(original);
      expect(serialized).not.toBeNull();
      const deserialized = await deserializeResult(serialized!);
      expect(deserialized).toEqual(original);
    });

    it("round-trips nested null values", async () => {
      const original = { user: null, items: [null, { name: "a" }] };
      const serialized = await serializeResult(original);
      expect(serialized).not.toBeNull();
      const deserialized = await deserializeResult(serialized!);
      expect(deserialized).toEqual(original);
    });
  });

  describe("rscSerialize (component-field variant)", () => {
    it("returns undefined for null input", async () => {
      const result = await rscSerialize(null);
      expect(result).toBeUndefined();
    });

    it("returns undefined for undefined input", async () => {
      const result = await rscSerialize(undefined);
      expect(result).toBeUndefined();
    });

    it("serializes non-null values", async () => {
      const result = await rscSerialize({ data: "test" });
      expect(result).not.toBeUndefined();
      expect(typeof result).toBe("string");
    });
  });

  describe("rscDeserialize (component-field variant)", () => {
    it("returns undefined for undefined input", async () => {
      const result = await rscDeserialize(undefined);
      expect(result).toBeUndefined();
    });

    it("returns undefined for empty string input", async () => {
      const result = await rscDeserialize("");
      expect(result).toBeUndefined();
    });
  });

  describe("null semantics contrast", () => {
    it("rscSerialize drops null, serializeResult preserves it", async () => {
      const rscResult = await rscSerialize(null);
      const resultResult = await serializeResult(null);

      // rscSerialize: used for component fields where null means "absent"
      expect(rscResult).toBeUndefined();

      // serializeResult: used for caching where null is a valid result
      expect(resultResult).not.toBeNull();
      expect(typeof resultResult).toBe("string");
    });
  });
});
