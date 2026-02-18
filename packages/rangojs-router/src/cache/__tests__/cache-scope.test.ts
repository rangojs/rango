import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedSegment } from "../../types.js";
import type { SerializedSegmentData } from "../types.js";

// Mock the RSC module. The real renderToReadableStream / createFromReadableStream
// require a full React Server Components runtime which is not available in vitest.
// We replace them with simple JSON-based encode/decode so we can test the
// serialize/deserialize logic in cache-scope without the RSC dependency.
vi.mock("@vitejs/plugin-rsc/rsc", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    createTemporaryReferenceSet: () => new Set(),

    // Simulate RSC serialization: encode the value as JSON into a ReadableStream.
    renderToReadableStream: (value: unknown) => {
      const json = JSON.stringify(value);
      const bytes = encoder.encode(json);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },

    // Simulate RSC deserialization: decode JSON from the ReadableStream.
    // This mirrors the real behavior: it reads bytes from the stream and
    // interprets them. Feeding it the literal string "null" (4 chars) will
    // produce the JSON value `null`, which is NOT the same as returning
    // JavaScript `null` at the call-site -- but critically, the function
    // is called at all, which is the bug. For a real RSC stream the bytes
    // "null" are not a valid Flight payload and would throw or produce
    // wrong data.
    createFromReadableStream: async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let result = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      result += decoder.decode(); // flush
      return JSON.parse(result);
    },
  };
});

// Mock getRequestContext -- serializeSegments does not use it, but the module
// imports it at the top level.
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => null,
}));

// Import AFTER mocks are registered so vitest applies them.
const { serializeSegments, deserializeSegments } = await import(
  "../cache-scope.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSegment(
  overrides: Partial<ResolvedSegment> = {}
): ResolvedSegment {
  return {
    id: "test-segment",
    namespace: "test",
    type: "route",
    index: 0,
    component: "component-placeholder",
    params: {},
    ...overrides,
  } as ResolvedSegment;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("serializeSegments / deserializeSegments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Serialization: verify the "null" sentinel is produced for loading: null
  // -------------------------------------------------------------------------
  describe("serializeSegments - loading field encoding", () => {
    it("should encode loading: undefined as encodedLoading: undefined", async () => {
      const segments = [makeSegment({ loading: undefined })];
      const serialized = await serializeSegments(segments);

      expect(serialized).toHaveLength(1);
      expect(serialized[0].encodedLoading).toBeUndefined();
    });

    it('should encode loading: null as encodedLoading: "null" (sentinel string)', async () => {
      const segments = [makeSegment({ loading: null })];
      const serialized = await serializeSegments(segments);

      expect(serialized).toHaveLength(1);
      expect(serialized[0].encodedLoading).toBe("null");
    });

    it("should encode a truthy loading value via RSC serialization", async () => {
      const loadingNode = { type: "div", props: { children: "Loading..." } } as ReactNode;
      const segments = [makeSegment({ loading: loadingNode })];
      const serialized = await serializeSegments(segments);

      expect(serialized).toHaveLength(1);
      // The mock RSC serializer produces a JSON string of the value.
      // The important thing is it is NOT the literal "null" sentinel.
      expect(serialized[0].encodedLoading).toBeDefined();
      expect(serialized[0].encodedLoading).not.toBe("null");
    });
  });

  // -------------------------------------------------------------------------
  // Deserialization: the bug -- "null" sentinel is not handled
  // -------------------------------------------------------------------------
  describe("deserializeSegments - loading field decoding (BUG P0-2)", () => {
    it("should deserialize encodedLoading: undefined as loading: undefined", async () => {
      const data: SerializedSegmentData[] = [
        {
          encoded: JSON.stringify("component-placeholder"),
          encodedLoading: undefined,
          metadata: {
            id: "seg-1",
            type: "route",
            namespace: "test",
            index: 0,
            params: {},
          },
        },
      ];

      const result = await deserializeSegments(data);

      expect(result).toHaveLength(1);
      // rscDeserialize returns undefined for falsy input, which becomes the
      // loading value. This case works correctly.
      expect(result[0].loading).toBeUndefined();
    });


    it("round-trip: loading: null should survive serialize -> deserialize as null", async () => {
      // This is the key round-trip test. A segment with loading: null should
      // produce loading: null after serialization and deserialization.
      //
      // With the current buggy code and our JSON mock, this may pass by
      // coincidence (JSON.parse("null") === null). See the spy-based test
      // above for the definitive bug demonstration.
      const original = [makeSegment({ loading: null })];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized).toHaveLength(1);
      expect(deserialized[0].loading).toBe(null);
    });

    it("round-trip: loading: undefined should survive serialize -> deserialize as undefined", async () => {
      const original = [makeSegment({ loading: undefined })];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized).toHaveLength(1);
      expect(deserialized[0].loading).toBeUndefined();
    });

    it("round-trip: truthy loading should survive serialize -> deserialize", async () => {
      const loadingNode = { type: "div", props: { children: "Loading..." } } as ReactNode;
      const original = [makeSegment({ loading: loadingNode })];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized).toHaveLength(1);
      expect(deserialized[0].loading).toEqual(loadingNode);
    });
  });

  // -------------------------------------------------------------------------
  // Direct rscDeserialize behavior test via deserializeSegments
  //
  // This tests that the "null" sentinel is handled at the deserialization
  // boundary, NOT inside rscDeserialize (which is a general-purpose function).
  // The fix should be in deserializeSegments, checking for "null" before
  // calling rscDeserialize.
  // -------------------------------------------------------------------------
  describe("sentinel handling must bypass rscDeserialize", () => {
    it('should NOT call createFromReadableStream when encodedLoading is "null"', async () => {
      // This is the most direct test for the bug. We intercept
      // createFromReadableStream at the module level to count calls.
      //
      // With the buggy code, createFromReadableStream is called 2 times:
      //   1. For the component (item.encoded)
      //   2. For the loading (item.encodedLoading = "null")
      // Plus potentially for layout, loaderData, loaderDataPromise (all undefined,
      // so rscDeserialize short-circuits for those).
      //
      // After the fix, createFromReadableStream should be called only 1 time
      // (for the component), because the "null" sentinel should be caught
      // before rscDeserialize is invoked.

      const rscModule = await import("@vitejs/plugin-rsc/rsc");
      const createSpy = vi.fn(rscModule.createFromReadableStream);

      // Temporarily replace the module's export
      const originalFn = rscModule.createFromReadableStream;
      (rscModule as any).createFromReadableStream = createSpy;

      const data: SerializedSegmentData[] = [
        {
          encoded: JSON.stringify("component-placeholder"),
          encodedLoading: "null",
          metadata: {
            id: "seg-sentinel",
            type: "route",
            namespace: "test",
            index: 0,
            params: {},
          },
        },
      ];

      const result = await deserializeSegments(data);

      // The loading value should be null (the JavaScript value), not whatever
      // the RSC decoder returns for the byte sequence "null".
      expect(result[0].loading).toBe(null);

      // BUG: With the current code, createFromReadableStream is called for
      // the "null" sentinel. After the fix it should only be called once
      // (for the component stream).
      //
      // This assertion WILL FAIL with the buggy code -- createFromReadableStream
      // is called 2 times (component + "null" sentinel passed to rscDeserialize).
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Restore
      (rscModule as any).createFromReadableStream = originalFn;
    });
  });
});
