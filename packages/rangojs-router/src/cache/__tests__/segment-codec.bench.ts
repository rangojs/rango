import { bench, describe, vi } from "vitest";
import type { ResolvedSegment } from "../../types.js";

// Mock the RSC module with lightweight JSON-based encode/decode
// so the benchmark measures parallelization overhead, not RSC runtime cost.
vi.mock("@vitejs/plugin-rsc/rsc", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    createTemporaryReferenceSet: () => new Set(),

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

    createFromReadableStream: async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let result = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      result += decoder.decode();
      return JSON.parse(result);
    },
  };
});

const { serializeSegments, deserializeSegments } =
  await import("../segment-codec.js");

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeSegment(i: number): ResolvedSegment {
  return {
    id: `seg-${i}`,
    namespace: "app",
    type: i % 3 === 0 ? "layout" : "route",
    index: i,
    component: {
      type: "div",
      props: { id: `component-${i}`, children: `Content ${i}` },
    },
    layout:
      i % 3 === 0
        ? {
            type: "nav",
            props: {
              items: Array.from({ length: 5 }, (_, j) => `item-${j}`),
            },
          }
        : undefined,
    loading:
      i % 2 === 0
        ? { type: "span", props: { children: "Loading..." } }
        : undefined,
    loaderData: { data: `value-${i}`, nested: { a: i, b: `str-${i}` } },
    params: { slug: `slug-${i}` },
  } as unknown as ResolvedSegment;
}

const smallBatch = Array.from({ length: 3 }, (_, i) => makeSegment(i));
const mediumBatch = Array.from({ length: 10 }, (_, i) => makeSegment(i));
const largeBatch = Array.from({ length: 30 }, (_, i) => makeSegment(i));

// Pre-serialize for deserialization benchmarks
const serializedSmall = await serializeSegments(smallBatch);
const serializedMedium = await serializeSegments(mediumBatch);
const serializedLarge = await serializeSegments(largeBatch);

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("segment codec serialize", () => {
  bench("serialize 3 segments", async () => {
    await serializeSegments(smallBatch);
  });

  bench("serialize 10 segments", async () => {
    await serializeSegments(mediumBatch);
  });

  bench("serialize 30 segments", async () => {
    await serializeSegments(largeBatch);
  });
});

describe("segment codec deserialize", () => {
  bench("deserialize 3 segments", async () => {
    await deserializeSegments(serializedSmall);
  });

  bench("deserialize 10 segments", async () => {
    await deserializeSegments(serializedMedium);
  });

  bench("deserialize 30 segments", async () => {
    await deserializeSegments(serializedLarge);
  });
});
