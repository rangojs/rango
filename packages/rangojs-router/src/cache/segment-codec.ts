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
import {
  renderToReadableStream,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";
import { createFromReadableStream } from "@vitejs/plugin-rsc/rsc";

// ============================================================================
// Stream Utilities (internal)
// ============================================================================

/**
 * Convert a ReadableStream to a string.
 */
export async function streamToString(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  result += decoder.decode(); // flush
  return result;
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

// ============================================================================
// RSC Serialization Primitives (internal)
// ============================================================================

/**
 * RSC-serialize a value using React Server Components stream.
 * Used for serializing loaderData, layout, loading components etc.
 */
export async function rscSerialize(value: unknown): Promise<string | undefined> {
  if (value === undefined || value === null) return undefined;

  const temporaryReferences = createTemporaryReferenceSet();
  const stream = renderToReadableStream(value, { temporaryReferences });
  return streamToString(stream);
}

/**
 * RSC-deserialize a value from a stored string.
 */
export async function rscDeserialize<T>(
  encoded: string | undefined
): Promise<T | undefined> {
  if (!encoded) return undefined;

  const temporaryReferences = createTemporaryReferenceSet();
  const stream = stringToStream(encoded);
  return createFromReadableStream<T>(stream, { temporaryReferences });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * RSC-deserialize a single encoded component string back to a React element.
 * Used by the static handler runtime to revive pre-rendered components.
 */
export async function deserializeComponent(
  encoded: string
): Promise<unknown> {
  const temporaryReferences = createTemporaryReferenceSet();
  const stream = stringToStream(encoded);
  return createFromReadableStream(stream, { temporaryReferences });
}

/**
 * Serialize segments for storage.
 * Each segment's component, layout, loading, and loaderData are RSC-serialized.
 * Metadata is preserved as-is.
 */
export async function serializeSegments(
  segments: ResolvedSegment[]
): Promise<SerializedSegmentData[]> {
  const serialized: SerializedSegmentData[] = [];

  for (const segment of segments) {
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

    // Convert stream to string
    const encoded = await streamToString(stream);

    // RSC-serialize layout if present (ReactNode)
    const encodedLayout = segment.layout
      ? await rscSerialize(segment.layout)
      : undefined;

    // RSC-serialize loading if present (ReactNode) - preserves tree structure
    // Use "null" string to distinguish explicit null from undefined
    const encodedLoading =
      segment.loading !== undefined
        ? segment.loading === null
          ? "null"
          : await rscSerialize(segment.loading)
        : undefined;

    // Await and RSC-serialize loaderData if present
    const loaderDataResolved =
      segment.loaderData instanceof Promise
        ? await segment.loaderData
        : segment.loaderData;
    const encodedLoaderData = await rscSerialize(loaderDataResolved);

    // Await and RSC-serialize loaderDataPromise if present
    const loaderDataPromiseResolved =
      segment.loaderDataPromise instanceof Promise
        ? await segment.loaderDataPromise
        : segment.loaderDataPromise;
    const encodedLoaderDataPromise = await rscSerialize(
      loaderDataPromiseResolved
    );

    serialized.push({
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
      },
    });
  }

  return serialized;
}

/**
 * Deserialize segments from storage.
 * Reconstructs ResolvedSegment objects from RSC-serialized data.
 */
export async function deserializeSegments(
  data: SerializedSegmentData[]
): Promise<ResolvedSegment[]> {
  const segments: ResolvedSegment[] = [];

  for (const item of data) {
    const temporaryReferences = createTemporaryReferenceSet();

    // Revive the component from cached string
    const stream = stringToStream(item.encoded);
    const component = await createFromReadableStream(stream, {
      temporaryReferences,
    });

    // RSC-deserialize layout, loaderData, loaderDataPromise in parallel.
    // Handle the "null" sentinel for loading before RSC deserialization.
    // During serialization, loading: null is stored as the string "null" to
    // distinguish it from undefined. This sentinel must be intercepted here
    // rather than passed to rscDeserialize, which would try to decode it as
    // an RSC Flight payload.
    const loadingIsNullSentinel = item.encodedLoading === "null";

    const [layout, loaderData, loaderDataPromise, loadingData] =
      await Promise.all([
        rscDeserialize(item.encodedLayout),
        rscDeserialize(item.encodedLoaderData),
        rscDeserialize(item.encodedLoaderDataPromise),
        loadingIsNullSentinel
          ? (null as any)
          : rscDeserialize(item.encodedLoading),
      ]);

    segments.push({
      ...item.metadata,
      component,
      layout,
      loading: loadingData,
      loaderData,
      loaderDataPromise,
    } as ResolvedSegment);
  }

  return segments;
}
