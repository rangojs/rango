/**
 * fragmentSegments (segment-codec.ts) + the lookupRoute fragment switch
 * (cache-scope.ts) — the producer half of the PPR fast-path payload splice
 * (issue #700). Pins that:
 *  - fragmentSegments carries the STORED strings verbatim in envelopes and
 *    never runs the Flight decoder for component/layout/loading;
 *  - expanding those envelopes yields exactly what deserializeSegments would
 *    have produced (consumer-side parity with the pre-splice path);
 *  - lookupRoute emits envelopes ONLY under the _shellFragmentPayload tail
 *    marker and keeps today's decode otherwise.
 *
 * The RSC codec is mocked JSON-style (same approach as cache-scope.test.ts):
 * the wire format is opaque to this layer — what matters is which strings
 * travel where and which decoder runs.
 */

import { describe, it, expect, vi } from "vitest";
import type { ResolvedSegment } from "../../types.js";
import type { SegmentCacheStore, CachedEntryData } from "../types.js";
import type { PartialCacheOptions } from "../../types.js";
import {
  isSegmentFragment,
  expandSegmentFragments,
} from "../../segment-fragments.js";

vi.mock("@vitejs/plugin-rsc/rsc", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    createTemporaryReferenceSet: () => new Set(),
    renderToReadableStream: (value: unknown) => {
      const bytes = encoder.encode(JSON.stringify(value));
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    createFromReadableStream: async (stream: ReadableStream<Uint8Array>) => {
      let result = "";
      const reader = stream.getReader();
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

const { serializeSegments, deserializeSegments, fragmentSegments } =
  await import("../segment-codec.js");
const { CacheScope } = await import("../cache-scope.js");
const { createRequestContext, runWithRequestContext } =
  await import("../../server/request-context.js");

/** JSON "decoder" matching the mocked codec — the consumer expansion stand-in. */
async function jsonDecode(stream: ReadableStream<Uint8Array>) {
  return JSON.parse(await new Response(stream).text());
}

function makeSegment(
  overrides: Partial<Record<keyof ResolvedSegment, unknown>> = {},
): ResolvedSegment {
  return {
    id: "seg-1",
    namespace: "test",
    type: "route",
    index: 0,
    component: { type: "div", props: { children: "baked" } },
    params: { a: "1" },
    ...overrides,
  } as ResolvedSegment;
}

describe("fragmentSegments", () => {
  it("envelopes component/layout/loading with the STORED strings verbatim", async () => {
    const serialized = await serializeSegments([
      makeSegment({
        layout: { type: "aside", props: {} },
        loading: { type: "p", props: { children: "..." } },
      }),
    ]);

    const [fragmented] = await fragmentSegments(serialized);

    expect(isSegmentFragment(fragmented.component)).toBe(true);
    expect((fragmented.component as any).f).toBe(serialized[0].encoded);
    expect(isSegmentFragment(fragmented.layout)).toBe(true);
    expect((fragmented.layout as any).f).toBe(serialized[0].encodedLayout);
    expect(isSegmentFragment(fragmented.loading)).toBe(true);
    expect((fragmented.loading as any).f).toBe(serialized[0].encodedLoading);
  });

  it("preserves the loading sentinel: null stays null, absent stays undefined", async () => {
    const serialized = await serializeSegments([
      makeSegment({ id: "n", loading: null }),
      makeSegment({ id: "u", loading: undefined }),
    ]);

    const [withNull, withUndefined] = await fragmentSegments(serialized);

    expect(withNull.loading).toBeNull();
    expect(withUndefined.loading).toBeUndefined();
  });

  it("preserves metadata and decodes loader data fields server-side (never enveloped)", async () => {
    const serialized = await serializeSegments([
      makeSegment({
        loaderData: { rows: [1, 2, 3] },
        transition: { name: "t" },
        mountPath: "/mnt",
      }),
    ]);

    const [fragmented] = await fragmentSegments(serialized);

    expect(fragmented.id).toBe("seg-1");
    expect(fragmented.params).toEqual({ a: "1" });
    expect(fragmented.transition).toEqual({ name: "t" });
    expect(fragmented.mountPath).toBe("/mnt");
    expect(isSegmentFragment(fragmented.loaderData)).toBe(false);
    expect(fragmented.loaderData).toEqual({ rows: [1, 2, 3] });
  });

  it("expansion parity: fragmentSegments + expandSegmentFragments equals deserializeSegments", async () => {
    const original = [
      makeSegment({
        layout: { type: "aside", props: {} },
        loading: null,
        loaderData: { n: 7 },
      }),
      makeSegment({ id: "seg-2", component: { type: "main", props: {} } }),
    ];
    const serialized = await serializeSegments(original);

    const viaDecode = await deserializeSegments(serialized);
    const viaFragments = await fragmentSegments(serialized);
    await expandSegmentFragments(viaFragments, jsonDecode);

    expect(viaFragments).toEqual(viaDecode);
  });
});

describe("CacheScope.lookupRoute under _shellFragmentPayload", () => {
  async function makeHitStore(): Promise<
    SegmentCacheStore & { entry: CachedEntryData }
  > {
    const segments = await serializeSegments([makeSegment()]);
    const entry: CachedEntryData = {
      segments,
      handles: "",
      expiresAt: Date.now() + 60_000,
    };
    return {
      entry,
      get: async () => ({ data: entry, shouldRevalidate: false }),
    } as unknown as SegmentCacheStore & { entry: CachedEntryData };
  }

  function makeCtx(store: SegmentCacheStore, fragmentPayload: boolean) {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com/products"),
      url: new URL("https://example.com/products"),
      variables: {},
      cacheStore: store,
    });
    if (fragmentPayload) ctx._shellFragmentPayload = true;
    return ctx;
  }

  function makeScope(store: SegmentCacheStore) {
    const config: PartialCacheOptions = { ttl: 60, store };
    return new CacheScope(config);
  }

  it("emits fragment envelopes on a hit when the tail marker is set", async () => {
    const store = await makeHitStore();
    const ctx = makeCtx(store, true);

    const result = await runWithRequestContext(ctx, () =>
      makeScope(store).lookupRoute("/products", {}),
    );

    expect(result).not.toBeNull();
    expect(isSegmentFragment(result!.segments[0].component)).toBe(true);
    expect((result!.segments[0].component as any).f).toBe(
      store.entry.segments[0].encoded,
    );
  });

  it("keeps the decoded-element path without the marker (every non-tail render)", async () => {
    const store = await makeHitStore();
    const ctx = makeCtx(store, false);

    const result = await runWithRequestContext(ctx, () =>
      makeScope(store).lookupRoute("/products", {}),
    );

    expect(result).not.toBeNull();
    expect(isSegmentFragment(result!.segments[0].component)).toBe(false);
    expect(result!.segments[0].component).toEqual({
      type: "div",
      props: { children: "baked" },
    });
  });
});
