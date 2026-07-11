/**
 * Segment Flight-fragment envelopes (PPR fast-path payload splice, issue #700).
 *
 * On a shell-HIT tail, replayed (baked) segments do NOT round-trip through the
 * server codec (deserialize -> re-serialize) per request. The stored RSC
 * fragment STRINGS ride the outgoing payload verbatim inside these envelopes
 * — the outer Flight render copies a string instead of re-serializing a whole
 * element tree — and the CONSUMER expands each envelope through its own Flight
 * deserializer: the SSR resume pass (ssr/ssr-root.tsx) and browser hydration
 * (browser/rsc-router.tsx). Each fragment is its own row space, decoded
 * independently, exactly like the segment codec's per-record decode — so
 * there is no Flight row-id collision or shared-row dedupe hazard.
 *
 * Envelopes appear ONLY on fields that hold ReactNodes (component / layout /
 * loading). A plain object is never a valid ReactNode, so the marker cannot
 * collide with legitimate segment content; loader data fields (consumer data,
 * any shape) are never enveloped.
 *
 * This module is shared client/server code (browser + SSR + RSC import it) —
 * it must stay dependency-free: no plugin-rsc, no request-context.
 */

import type { ResolvedSegment } from "./types.js";

/**
 * One RSC-encoded fragment traveling inside an RscPayload segment field.
 * `f` is the stored Flight document (segment-codec output) for that field.
 */
export interface SegmentFlightFragment {
  __rangoFragment: 1;
  f: string;
}

/** Wrap a stored fragment string for the wire. */
export function segmentFragment(encoded: string): SegmentFlightFragment {
  return { __rangoFragment: 1, f: encoded };
}

/** True iff `value` is a fragment envelope (see collision note in the header). */
export function isSegmentFragment(
  value: unknown,
): value is SegmentFlightFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __rangoFragment?: unknown }).__rangoFragment === 1 &&
    typeof (value as { f?: unknown }).f === "string"
  );
}

/**
 * A consumer-side Flight deserializer: the browser's or the SSR runtime's
 * createFromReadableStream (each resolves client references through its own
 * module map, exactly as it does for the outer payload stream). Non-generic
 * so both environments' generic createFromReadableStream signatures assign
 * directly.
 */
export type FragmentDecoder = (
  stream: ReadableStream<Uint8Array>,
) => Promise<unknown>;

/** One-chunk byte stream over an encoded fragment (local: this module must not
 *  import segment-codec, which pulls plugin-rsc into client bundles). */
function fragmentToStream(encoded: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(encoded);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** The segment fields that may carry an envelope (ReactNode fields only). */
const FRAGMENT_FIELDS = ["component", "layout", "loading"] as const;

/**
 * Expand every fragment envelope in `segments` IN PLACE via `decode`,
 * in parallel. A payload with no envelopes (every non-shell-HIT payload) costs
 * one synchronous field scan. A failing fragment decode rejects the whole
 * expansion: the caller's payload promise rejects, which on the SSR side
 * errors the HIT tail (serveShellHit then schedules the healing recapture) —
 * the same posture as a parseable-but-mismatched postponed blob.
 */
export async function expandSegmentFragments(
  segments: ResolvedSegment[] | undefined,
  decode: FragmentDecoder,
): Promise<void> {
  if (!segments || segments.length === 0) return;
  const decodes: Promise<void>[] = [];
  for (const segment of segments) {
    for (const field of FRAGMENT_FIELDS) {
      const value = segment[field];
      if (isSegmentFragment(value)) {
        // Promise.resolve() adoption is load-bearing: some deserializers
        // (react-server-dom's Flight client) return a THENABLE Chunk whose
        // .then returns undefined — chaining directly would push undefined
        // into the barrier and Promise.all would not wait for the decode.
        decodes.push(
          Promise.resolve(decode(fragmentToStream(value.f))).then((node) => {
            segment[field] = node as ResolvedSegment[typeof field];
          }),
        );
      }
    }
  }
  if (decodes.length > 0) await Promise.all(decodes);
}

/**
 * True when any segment carries an unexpanded envelope. Cheap scan used by
 * consumers that only need to know whether an expansion pass is required.
 */
export function hasSegmentFragments(
  segments: ResolvedSegment[] | undefined,
): boolean {
  if (!segments) return false;
  for (const segment of segments) {
    for (const field of FRAGMENT_FIELDS) {
      if (isSegmentFragment(segment[field])) return true;
    }
  }
  return false;
}
