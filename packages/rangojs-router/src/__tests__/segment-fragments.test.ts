/**
 * Fragment envelope contract (segment-fragments.ts, issue #700): the shape the
 * PPR fast-path HIT payload carries for replayed segments, and the consumer
 * expansion pass the SSR resume render and browser hydration both run. The
 * envelope must be detectable without false positives, expansion must replace
 * every enveloped field in place through the provided decoder, and a payload
 * with no envelopes must never touch the decoder (every non-shell-HIT payload
 * pays only the field scan).
 */

import { describe, it, expect, vi } from "vitest";
import {
  segmentFragment,
  isSegmentFragment,
  expandSegmentFragments,
  hasSegmentFragments,
} from "../segment-fragments.js";
import type { ResolvedSegment } from "../types.js";

function makeSegment(
  overrides: Partial<Record<keyof ResolvedSegment, unknown>>,
): ResolvedSegment {
  return {
    id: "seg-1",
    namespace: "test",
    type: "route",
    index: 0,
    component: null,
    params: {},
    ...overrides,
  } as ResolvedSegment;
}

/** Decoder that returns a tagged object carrying the decoded fragment text. */
function makeDecoder() {
  return vi.fn(async (stream: ReadableStream<Uint8Array>) => {
    const text = await new Response(stream).text();
    return { decodedFrom: text };
  });
}

describe("segmentFragment / isSegmentFragment", () => {
  it("round-trips the encoded string through the envelope", () => {
    const env = segmentFragment("1:D{}\n0:[]\n");
    expect(isSegmentFragment(env)).toBe(true);
    expect(env.f).toBe("1:D{}\n0:[]\n");
  });

  it("rejects non-envelope values (elements, null, plain objects, strings)", () => {
    expect(isSegmentFragment(null)).toBe(false);
    expect(isSegmentFragment(undefined)).toBe(false);
    expect(isSegmentFragment("0:[]")).toBe(false);
    expect(isSegmentFragment({ type: "div", props: {} })).toBe(false);
    // Marker key present but wrong shape.
    expect(isSegmentFragment({ __rangoFragment: 1 })).toBe(false);
    expect(isSegmentFragment({ __rangoFragment: 2, f: "x" })).toBe(false);
    expect(isSegmentFragment({ __rangoFragment: 1, f: 42 })).toBe(false);
  });
});

describe("expandSegmentFragments", () => {
  it("expands component, layout, and loading envelopes in place, in parallel", async () => {
    const decode = makeDecoder();
    const segment = makeSegment({
      component: segmentFragment("COMPONENT"),
      layout: segmentFragment("LAYOUT"),
      loading: segmentFragment("LOADING"),
    });

    await expandSegmentFragments([segment], decode);

    expect(decode).toHaveBeenCalledTimes(3);
    expect(segment.component).toEqual({ decodedFrom: "COMPONENT" });
    expect(segment.layout).toEqual({ decodedFrom: "LAYOUT" });
    expect(segment.loading).toEqual({ decodedFrom: "LOADING" });
  });

  it("leaves non-envelope fields untouched (mixed payload: fresh + replayed segments)", async () => {
    const decode = makeDecoder();
    const element = { type: "div", props: {} };
    const fresh = makeSegment({ id: "fresh", component: element });
    const replayed = makeSegment({
      id: "replayed",
      component: segmentFragment("R"),
    });

    await expandSegmentFragments([fresh, replayed], decode);

    expect(decode).toHaveBeenCalledTimes(1);
    expect(fresh.component).toBe(element);
    expect(replayed.component).toEqual({ decodedFrom: "R" });
  });

  it("preserves loading: null and loading: undefined (the sentinel decodes server-side)", async () => {
    const decode = makeDecoder();
    const withNull = makeSegment({ id: "a", loading: null });
    const withUndefined = makeSegment({ id: "b", loading: undefined });

    await expandSegmentFragments([withNull, withUndefined], decode);

    expect(decode).not.toHaveBeenCalled();
    expect(withNull.loading).toBeNull();
    expect(withUndefined.loading).toBeUndefined();
  });

  it("never calls the decoder for an envelope-free payload and tolerates undefined/empty input", async () => {
    const decode = makeDecoder();
    await expandSegmentFragments(undefined, decode);
    await expandSegmentFragments([], decode);
    await expandSegmentFragments([makeSegment({ component: null })], decode);
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects when a fragment decode fails (the payload promise must reject, not half-expand silently)", async () => {
    const decode = vi.fn(async () => {
      throw new Error("corrupt fragment");
    });
    const segment = makeSegment({
      component: segmentFragment("X"),
    });
    await expect(expandSegmentFragments([segment], decode)).rejects.toThrow(
      "corrupt fragment",
    );
  });

  it("does not expand loaderData even if it happens to match the envelope shape (ReactNode fields only)", async () => {
    const decode = makeDecoder();
    const userData = { __rangoFragment: 1, f: "consumer data, not ours" };
    const segment = makeSegment({ id: "ld", loaderData: userData });

    await expandSegmentFragments([segment], decode);

    expect(decode).not.toHaveBeenCalled();
    expect(segment.loaderData).toBe(userData);
  });
});

describe("hasSegmentFragments", () => {
  it("detects an unexpanded envelope on any field and is false otherwise", () => {
    expect(hasSegmentFragments(undefined)).toBe(false);
    expect(hasSegmentFragments([makeSegment({ component: null })])).toBe(false);
    expect(
      hasSegmentFragments([makeSegment({ layout: segmentFragment("L") })]),
    ).toBe(true);
  });
});
