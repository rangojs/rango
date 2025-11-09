/**
 * RSC Framework Types
 *
 * Type definitions for RSC payloads and framework integration
 */

import type { ReactFormState } from 'react-dom/client';
import type { SegmentType } from '../segment-system';

/**
 * Segment metadata for serialization (without component)
 *
 * This is the serializable version of Segment that can be sent
 * through RSC streams. It contains all metadata but NOT the component
 * function/ReactNode (which can't be serialized).
 */
export type SegmentMetadata = {
  /**
   * Unique segment ID (e.g., 'L0', 'R2', 'P3')
   */
  id: string;

  /**
   * Segment type
   */
  type: SegmentType;

  /**
   * Sequential index number
   */
  index: number;

  /**
   * Slot name for parallel segments (e.g., '@sidebar', '@modal')
   */
  slot?: string;

  /**
   * Path pattern for this segment
   */
  path?: string;

  /**
   * Route params for this segment
   */
  params?: Record<string, string>;
};

/**
 * RSC Payload schema for serialization/deserialization
 *
 * This payload is serialized into RSC stream on the rsc environment
 * and deserialized on ssr/client environments.
 *
 * IMPORTANT: Only serializable data can be in this payload. Function
 * components cannot be serialized - they must be rendered server-side
 * and sent as ReactNodes in the 'root' field.
 */
export type RscPayload = {
  /**
   * The root React component to render
   * Can be the entire app or partial segments (already rendered)
   */
  root: React.ReactNode;

  /**
   * Server action return value (non-progressive enhancement)
   */
  returnValue?: unknown;

  /**
   * Server action form state (progressive enhancement with useActionState)
   */
  formState?: ReactFormState;

  /**
   * Metadata for partial rendering and segment management
   *
   * IMPORTANT: This only contains metadata (IDs, types, indices), NOT components.
   * Components are rendered server-side and sent in the 'root' field.
   */
  metadata?: {
    /**
     * Current pathname
     */
    pathname: string;

    /**
     * Segment metadata (WITHOUT components - just IDs, types, etc.)
     */
    segments: SegmentMetadata[];

    /**
     * Start index for partial updates (where segments diverge)
     */
    startIndex?: number;

    /**
     * Preserved layout paths (layouts that don't need re-rendering)
     */
    preservedLayouts?: string[];

    /**
     * Flag indicating this is a partial response
     */
    isPartial?: boolean;
  };
};

/**
 * Convert Segment to SegmentMetadata (strip component)
 *
 * Removes the component property so the segment can be serialized
 * through RSC streams.
 */
export function toSegmentMetadata(segment: {
  id: string;
  type: SegmentType;
  index: number;
  slot?: string;
  path?: string;
  params?: Record<string, string>;
}): SegmentMetadata {
  return {
    id: segment.id,
    type: segment.type,
    index: segment.index,
    slot: segment.slot,
    path: segment.path,
    params: segment.params,
  };
}
