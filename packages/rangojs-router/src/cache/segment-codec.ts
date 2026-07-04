/**
 * Segment Codec
 *
 * RSC serialization/deserialization for cached segments.
 * Handles the Flight protocol stream <-> string conversion
 * and the segment-level encode/decode lifecycle.
 */

/// <reference types="@vitejs/plugin-rsc/types" />

import type { ResolvedSegment } from "../types.js";
import type { SerializedSegmentData } from "./types.js";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
import {
  renderToReadableStream,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";
import { createFromReadableStream } from "@vitejs/plugin-rsc/rsc";

/**
 * Convert a ReadableStream to a string.
 */
export async function streamToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode()); // flush
  return chunks.join("");
}

/**
 * Convert a string to a ReadableStream.
 */
export function stringToStream(str: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const uint8 = encoder.encode(str);

  return new ReadableStream({
    start(controller) {
      controller.enqueue(uint8);
      controller.close();
    },
  });
}

/**
 * RSC-serialize a value using React Server Components stream.
 * Used for serializing loaderData, layout, loading components etc.
 *
 * Returns undefined for null/undefined inputs (component fields that are absent).
 * For contexts where null is a valid result (loader caching, "use cache"),
 * use serializeResult() instead which preserves null through RSC Flight.
 */
export async function rscSerialize(
  value: unknown,
): Promise<string | undefined> {
  if (value === undefined || value === null) return undefined;

  const temporaryReferences = createTemporaryReferenceSet();
  const stream = renderToReadableStream(value, { temporaryReferences });
  return streamToString(stream);
}

/**
 * RSC-deserialize a value from a stored string.
 */
export async function rscDeserialize<T>(
  encoded: string | undefined,
): Promise<T | undefined> {
  if (!encoded) return undefined;

  const temporaryReferences = createTemporaryReferenceSet();
  const stream = stringToStream(encoded);
  return createFromReadableStream<T>(stream, { temporaryReferences });
}

/**
 * RSC-serialize any value including null.
 * Unlike rscSerialize(), this does NOT skip null — it serializes it through
 * RSC Flight so that a loader returning null produces a valid cached entry
 * rather than a permanent cache miss.
 *
 * Returns null only on serialization failure.
 */
export async function serializeResult(value: unknown): Promise<string | null> {
  try {
    const temporaryReferences = createTemporaryReferenceSet();
    const stream = renderToReadableStream(value, { temporaryReferences });
    return await streamToString(stream);
  } catch (error) {
    // Returning null silently turns a non-serializable cache value into a
    // permanent miss with no trace. Surface it on the internal debug channel so
    // a failed serialize is diagnosable on wrangler tail, but keep returning
    // null so the caller falls through to an uncached render rather than throws.
    if (INTERNAL_RANGO_DEBUG) {
      console.warn("[segment-codec] serializeResult failed:", error);
    }
    return null;
  }
}

/**
 * RSC-deserialize a cached result string.
 * Counterpart to serializeResult() — always receives a non-empty string.
 */
export async function deserializeResult<T>(encoded: string): Promise<T> {
  const temporaryReferences = createTemporaryReferenceSet();
  const stream = stringToStream(encoded);
  return createFromReadableStream<T>(stream, { temporaryReferences });
}

/**
 * RSC-deserialize a single encoded component string back to a React element.
 * Used by the static handler runtime to revive pre-rendered components.
 * Identical to deserializeResult<unknown>.
 */
export const deserializeComponent: (encoded: string) => Promise<unknown> =
  deserializeResult;

/**
 * Serialize segments for storage.
 * Each segment's component, layout, loading, and loaderData are RSC-serialized.
 * Metadata is preserved as-is.
 */
export async function serializeSegments(
  segments: ResolvedSegment[],
): Promise<SerializedSegmentData[]> {
  return Promise.all(
    segments.map(async (segment): Promise<SerializedSegmentData> => {
      const temporaryReferences = createTemporaryReferenceSet();

      // Await component if it's a Promise (intercepts with loading keep component as Promise)
      const componentResolved =
        segment.component instanceof Promise
          ? await segment.component
          : segment.component;

      // Serialize the component to RSC stream
      const stream = renderToReadableStream(componentResolved, {
        temporaryReferences,
      });

      // RSC-serialize loading: "null" string distinguishes explicit null from undefined
      const encodedLoading =
        segment.loading !== undefined
          ? segment.loading === null
            ? "null"
            : await rscSerialize(segment.loading)
          : undefined;

      // Await loaderData / loaderDataPromise if they're Promises
      const loaderDataResolved =
        segment.loaderData instanceof Promise
          ? await segment.loaderData
          : segment.loaderData;
      const loaderDataPromiseResolved =
        segment.loaderDataPromise instanceof Promise
          ? await segment.loaderDataPromise
          : segment.loaderDataPromise;

      // Parallelize stream-to-string and RSC serialization of sub-fields
      const [
        encoded,
        encodedLayout,
        encodedLoaderData,
        encodedLoaderDataPromise,
      ] = await Promise.all([
        streamToString(stream),
        segment.layout ? rscSerialize(segment.layout) : undefined,
        rscSerialize(loaderDataResolved),
        rscSerialize(loaderDataPromiseResolved),
      ]);

      return {
        encoded,
        encodedLayout,
        encodedLoading,
        encodedLoaderData,
        encodedLoaderDataPromise,
        metadata: {
          id: segment.id,
          type: segment.type,
          namespace: segment.namespace,
          index: segment.index,
          params: segment.params,
          slot: segment.slot,
          belongsToRoute: segment.belongsToRoute,
          layoutName: segment.layoutName,
          parallelName: segment.parallelName,
          loaderId: segment.loaderId,
          loaderIds: segment.loaderIds,
          transition: segment.transition,
          mountPath: segment.mountPath,
        },
      };
    }),
  );
}

/**
 * Deserialize segments from storage.
 * Reconstructs ResolvedSegment objects from RSC-serialized data.
 */
export async function deserializeSegments(
  data: SerializedSegmentData[],
): Promise<ResolvedSegment[]> {
  return Promise.all(
    data.map(async (item): Promise<ResolvedSegment> => {
      const temporaryReferences = createTemporaryReferenceSet();

      // Handle the "null" sentinel for loading before RSC deserialization.
      // During serialization, loading: null is stored as the string "null" to
      // distinguish it from undefined.
      const loadingIsNullSentinel = item.encodedLoading === "null";

      const [component, layout, loaderData, loaderDataPromise, loadingData] =
        await Promise.all([
          createFromReadableStream(stringToStream(item.encoded), {
            temporaryReferences,
          }),
          rscDeserialize(item.encodedLayout),
          rscDeserialize(item.encodedLoaderData),
          rscDeserialize(item.encodedLoaderDataPromise),
          loadingIsNullSentinel
            ? (null as any)
            : rscDeserialize(item.encodedLoading),
        ]);

      return {
        ...item.metadata,
        component,
        layout,
        loading: loadingData,
        loaderData,
        loaderDataPromise,
      } as ResolvedSegment;
    }),
  );
}
