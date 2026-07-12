import { describe, it, expect, vi } from "vitest";

// cacheRoute serializes segments through segment-codec, whose real RSC codec
// needs a Flight runtime vitest lacks. Same JSON-based stand-in as
// cache-scope.test.ts, mocked at the virtual-module seam so every importer
// (cache-scope AND handle-snapshot) sees it.
vi.mock("@vitejs/plugin-rsc/rsc", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    createTemporaryReferenceSet: () => new Set(),
    renderToReadableStream: (value: unknown) => {
      const bytes = encoder.encode(JSON.stringify(value) ?? "null");
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
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      return JSON.parse(result + decoder.decode());
    },
  };
});

import { withCacheStore } from "../cache-store.js";
import { runWithRouterContext } from "../../router-context.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";
import {
  CacheScope,
  resolveShellImplicitCacheScope,
} from "../../../cache/cache-scope.js";
import {
  RecordingShellStore,
  SnapshotOnlySegmentStore,
} from "../../../cache/shell-snapshot.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import type { ShellSnapshotRecord } from "../../../cache/types.js";
import { seg, gen, makeCacheStoreRouterContextStub } from "./helpers.js";

// Capture-side composition: a SHELL CAPTURE of a route with a route-derived
// cache() scope must record the canonical doc segment record snapshot-only
// (through the marker's SnapshotOnlySegmentStore) IN ADDITION to the scope's
// normal write — otherwise navigation replay is structurally dead for any ppr
// route under a cache() scope (the storefront app-wide cache() shape).

interface Harness {
  reqCtx: RequestContext<any>;
  recording: RecordingShellStore;
  inner: MemorySegmentCacheStore;
  drainSnapshot: () => ShellSnapshotRecord[] | undefined;
  run: (
    cacheScope: CacheScope | null,
    stateOverrides?: Partial<MatchPipelineState>,
    fireOnResponse?: boolean,
  ) => Promise<void>;
}

/**
 * Build a capture-shaped request context: recording store as the app store,
 * `_shellCaptureRun` set, and the capture marker whose store is the
 * SnapshotOnlySegmentStore — exactly what createDerivedContext installs.
 * The document identity URL carries no `_rsc_partial`, so key resolution
 * lands in the `doc:` namespace on both the marker and a default-keyed
 * explicit scope.
 */
function makeHarness(): Harness {
  const inner = new MemorySegmentCacheStore();
  const recording = new RecordingShellStore(inner);
  const url = new URL("http://localhost/p");
  const request = new Request(url, { headers: { accept: "text/html" } });
  const pending: Promise<unknown>[] = [];
  const reqCtx = createRequestContext<any>({
    env: {},
    request,
    url,
    variables: {},
    executionContext: {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
    } as any,
  }) as RequestContext<any>;
  reqCtx._cacheStore = recording;
  reqCtx._shellCaptureRun = true;
  reqCtx._shellImplicitCache = {
    ttl: 300,
    swr: 60,
    store: new SnapshotOnlySegmentStore(recording),
    keyPrefix: "doc",
  };

  const run: Harness["run"] = async (
    cacheScope,
    stateOverrides = {},
    fireOnResponse = true,
  ) => {
    const ctx = {
      cacheScope,
      isAction: false,
      isIntercept: false,
      request,
      pathname: "/p",
      clientSegmentSet: new Set<string>(),
      metricsStore: undefined,
      matched: { params: {}, routeKey: "home" },
      url,
    } as unknown as MatchContext<any>;
    const state = {
      cacheHit: false,
      interceptSegments: [],
      ...stateOverrides,
    } as unknown as MatchPipelineState;

    await runWithRouterContext(makeCacheStoreRouterContextStub(), () =>
      runWithRequestContext(reqCtx, async () => {
        const mw = withCacheStore(ctx, state);
        for await (const _ of mw(gen([seg("R0"), seg("R0.page")]))) {
          // pass-through
        }
        if (fireOnResponse) {
          for (const cb of reqCtx._onResponseCallbacks) {
            cb(new Response(null, { status: 200 }));
          }
        }
        // cacheRoute awaits handleStore.settled before serializing.
        reqCtx._handleStore.seal();
        // A waitUntil task can schedule nested waitUntil tasks (cacheRoute's
        // store write) — drain in batches until quiet, like settleWrites does.
        while (pending.length > 0) {
          await Promise.all(pending.splice(0));
        }
      }),
    );
  };

  return {
    reqCtx,
    recording,
    inner,
    drainSnapshot: () => recording.drainSnapshot(),
    run,
  };
}

function docRecords(
  snapshot: ShellSnapshotRecord[] | undefined,
): ShellSnapshotRecord[] {
  return (snapshot ?? []).filter(
    (r) => r.family === "segment" && r.key.startsWith("doc:"),
  );
}

describe("withCacheStore — shell capture doc record under a route-derived cache() scope", () => {
  it("records the doc segment record snapshot-only alongside the explicit tier's write, and publishes docKey", async () => {
    const h = makeHarness();
    // Explicit scope with a custom key: its own write lands under the
    // consumer's key in the REAL store, while the composed doc record must
    // land under the canonical doc key in the snapshot ONLY.
    const explicit = new CacheScope({ ttl: 30, key: () => "consumer-key" });

    await h.run(explicit);

    const snapshot = h.drainSnapshot();
    const doc = docRecords(snapshot);
    expect(doc).toHaveLength(1);
    expect(doc[0]!.key).toBe("doc:localhost/p");
    expect(h.reqCtx._shellImplicitCache?.docKey).toBe("doc:localhost/p");
    // Explicit tier's own write went through (recorded AND persisted)…
    expect(await h.inner.get("consumer-key")).not.toBeNull();
    // …but the doc record stayed snapshot-only: no real-store doc entry that
    // would poison the next capture's lookup.
    expect(await h.inner.get("doc:localhost/p")).toBeNull();
  });

  it("records the doc record on the explicit tier's HIT path too (state.cacheHit skips only the normal write)", async () => {
    const h = makeHarness();
    const explicit = new CacheScope({ ttl: 30, key: () => "consumer-key" });

    // cacheHit: the served segments still flowed through the pipeline into
    // allSegments; onResponse is never registered on this branch.
    await h.run(explicit, { cacheHit: true, cacheSource: "runtime" }, false);

    const doc = docRecords(h.drainSnapshot());
    expect(doc).toHaveLength(1);
    expect(h.reqCtx._shellImplicitCache?.docKey).toBe("doc:localhost/p");
    // The normal write was skipped (cacheHit), so the consumer key is absent.
    expect(await h.inner.get("consumer-key")).toBeNull();
  });

  it("records nothing for cache(false) — the opt-out is absolute", async () => {
    const h = makeHarness();
    await h.run(new CacheScope(false));

    expect(h.drainSnapshot()).toBeUndefined();
    expect(h.reqCtx._shellImplicitCache?.docKey).toBeUndefined();
  });

  it("records the doc record even when the scope's condition() refuses the write (arming vehicle for lookup-time cache-disabled)", async () => {
    // The shell entry already bakes this render's handler output as the
    // served HTML prelude, so the snapshot-only record adds no exposure. It
    // must exist or replay eligibility fails first and an always-false
    // condition() reports no-segment-snapshot instead of the lookup-time
    // cache-disabled the composition contract promises. Serving stays
    // lookup-gated: condition() is re-evaluated by lookupRouteDetailed.
    const h = makeHarness();
    const explicit = new CacheScope({ ttl: 30, condition: () => false });
    await h.run(explicit);

    const doc = docRecords(h.drainSnapshot());
    expect(doc).toHaveLength(1);
    expect(h.reqCtx._shellImplicitCache?.docKey).toBe("doc:localhost/p");
    // The explicit tier's own write stays refused by its condition — only the
    // snapshot-only doc record is recorded.
    expect(await h.inner.get("doc:localhost/p")).toBeNull();
  });

  it("records nothing when the prerender store supplied the match", async () => {
    const h = makeHarness();
    const explicit = new CacheScope({ ttl: 30 });

    await h.run(explicit, { cacheHit: true, cacheSource: "prerender" }, false);

    expect(h.drainSnapshot()).toBeUndefined();
  });

  it("records nothing outside a capture render (replay serve must not mint doc records)", async () => {
    const h = makeHarness();
    h.reqCtx._shellCaptureRun = undefined;
    const explicit = new CacheScope({ ttl: 30, key: () => "consumer-key" });

    await h.run(explicit);

    // Only the explicit tier's own recorded write exists — under the
    // consumer's key, not the doc namespace.
    expect(docRecords(h.drainSnapshot())).toHaveLength(0);
  });

  it("skips the composition for the implicit scope itself — its own cacheRoute records the doc record exactly once", async () => {
    const h = makeHarness();
    const implicit = runWithRequestContext(h.reqCtx, () =>
      resolveShellImplicitCacheScope(null),
    );

    // Without firing onResponse the implicit scope's normal write never runs;
    // a record here would mean the composition double-recorded the bare route.
    await h.run(implicit, {}, false);
    expect(h.drainSnapshot()).toBeUndefined();

    // With onResponse fired, the normal path records it exactly once.
    await h.run(implicit, {}, true);
    const doc = docRecords(h.drainSnapshot());
    expect(doc).toHaveLength(1);
    expect(h.reqCtx._shellImplicitCache?.docKey).toBe("doc:localhost/p");
  });
});
