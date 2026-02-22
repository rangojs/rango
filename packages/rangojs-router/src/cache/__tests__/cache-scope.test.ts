import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedSegment } from "../../types.js";
import type { SerializedSegmentData } from "../types.js";

// Mock the RSC module. The real renderToReadableStream / createFromReadableStream
// require a full React Server Components runtime which is not available in vitest.
// We replace them with simple JSON-based encode/decode so we can test the
// serialize/deserialize logic without the RSC dependency.
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

// Import AFTER mocks are registered so vitest applies them.
const { serializeSegments, deserializeSegments } = await import(
  "../segment-codec.js"
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

  describe("serializeSegments - loading field encoding", () => {
    it("should encode loading: undefined as encodedLoading: undefined", async () => {
      const segments = [makeSegment({ loading: undefined })];
      const serialized = await serializeSegments(segments);

      expect(serialized).toHaveLength(1);
      expect(serialized[0].encodedLoading).toBeUndefined();
    });

    it('should encode loading: null as "null" sentinel string', async () => {
      // loading: null is stored as the literal string "null" to distinguish
      // it from undefined. Both produce the same tree shape, but the
      // reconciler compares loading values for structural preservation.
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

  describe("deserializeSegments - loading field decoding", () => {
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
      expect(result[0].loading).toBeUndefined();
    });

    it("round-trip: loading: null should survive serialize -> deserialize as null", async () => {
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

  describe("metadata preservation", () => {
    it("should preserve segment metadata through round-trip", async () => {
      const original = [makeSegment({
        id: "L0",
        type: "layout",
        namespace: "app",
        index: 2,
        params: { slug: "hello" },
        slot: "main",
        belongsToRoute: true,
        layoutName: "root",
        loaderId: "loader-1",
        loaderIds: ["a", "b"],
      })];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized).toHaveLength(1);
      const seg = deserialized[0];
      expect(seg.id).toBe("L0");
      expect(seg.type).toBe("layout");
      expect(seg.namespace).toBe("app");
      expect(seg.index).toBe(2);
      expect(seg.params).toEqual({ slug: "hello" });
      expect(seg.slot).toBe("main");
      expect(seg.belongsToRoute).toBe(true);
      expect(seg.layoutName).toBe("root");
      expect(seg.loaderId).toBe("loader-1");
      expect(seg.loaderIds).toEqual(["a", "b"]);
    });

    it("should round-trip component values", async () => {
      const original = [makeSegment({ component: { type: "div", props: { id: "test" } } as any })];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized[0].component).toEqual({ type: "div", props: { id: "test" } });
    });

    it("should round-trip layout values", async () => {
      const original = [makeSegment({ layout: { type: "nav", props: {} } as any })];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized[0].layout).toEqual({ type: "nav", props: {} });
    });
  });

  describe("sentinel handling must bypass rscDeserialize", () => {
    it('should NOT call createFromReadableStream when encodedLoading is "null"', async () => {
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

      // createFromReadableStream should only be called once (for the component
      // stream). The "null" sentinel should be caught before rscDeserialize.
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Restore
      (rscModule as any).createFromReadableStream = originalFn;
    });
  });
});
