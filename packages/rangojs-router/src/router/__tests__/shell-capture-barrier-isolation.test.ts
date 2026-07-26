import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createElement } from "react";
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { createHandle } from "../../handle.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import { deriveShellCaptureContext } from "../../rsc/shell-capture.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

// Render-barrier isolation for the PPR capture lane (issue #684, plan 009).
//
// The capture context is `Object.create(reqCtx)`. Before wireRenderBarrier was
// applied to it, every `_renderBarrier*` read fell through the prototype to the
// FOREGROUND request's barrier — whose getter and resolver are closure-bound to
// the foreground ctx and its handle store, and whose resolver no-ops once
// resolved. A bake-lane loader's `await ctx.rendered()` during capture then
// resolved instantly against the foreground's already-resolved barrier, and
// `ctx.use(handle)` read the FOREGROUND handle snapshot: the capture's fresh
// `_handleStore` was invisible, so foreground per-request handle data could
// bake into the shared shell.
//
// These tests drive the REAL match path (createRouter -> routes() -> trie ->
// router.match) with production wiring: a real createRequestContext foreground
// pass first (resolving the foreground barrier and building its snapshot),
// then a capture pass under the REAL deriveShellCaptureContext derivation. The
// handler pushes a per-render marker, so which snapshot the loader read is
// unambiguous.

const TitleHandle = createHandle<string, string[]>(
  (s) => s.flat(),
  "test#BarrierIsoTitle",
);

// Per-render marker: foreground pushes render-1, capture pushes render-2.
let renderCounter = 0;

// Every `await ctx.rendered(); ctx.use(handle)` read, in completion order:
// foreground first, capture second.
const collected: string[][] = [];

const BarrierLoader = (createLoader as Function)(
  async (lctx: any) => {
    await lctx.rendered();
    const titles = lctx.get(TitleHandle);
    collected.push(titles);
    return { titles };
  },
  undefined,
  "test#BarrierIsoLoader",
);

// Bake-lane shape: the loader's entry has NO loading(), so its body executes
// during the capture (docs/design/loader-container-bake.md).
const PageHandler = (ctx: any) => {
  const push = ctx.use(TitleHandle);
  push(`render-${++renderCounter}`);
  return createElement("div", null, "page");
};

const RootLayout = () => createElement("div", null, "layout");
const Fallback = createElement("span", null, "slot-fallback");

// Streaming tree variant: a parallel slot behind loading() pushes AFTER an
// await, so _treeHasStreaming is true and the push lands past the barrier.
const StreamingSlot = async (ctx: any) => {
  const push = ctx.use(TitleHandle);
  await new Promise((r) => setTimeout(r, 10));
  push(`stream-${++renderCounter}`);
  return createElement("div", null, "slot");
};

let router: any;

beforeAll(async () => {
  router = createRouter({} as any);
  router.routes(({ layout, loader, loading, parallel, path }: any) => [
    layout(RootLayout, () => [
      path("/plain", PageHandler, { name: "barrierIsoPlain" }, () => [
        loader(BarrierLoader),
      ]),
    ]),
    layout(RootLayout, () => [
      parallel({ "@side": StreamingSlot }, () => [loading(Fallback)]),
      path(
        "/streaming",
        () => createElement("div", null, "streaming-page"),
        { name: "barrierIsoStreaming" },
        () => [loader(BarrierLoader)],
      ),
    ]),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

beforeEach(() => {
  renderCounter = 0;
  collected.length = 0;
});

function makeRequest(pathname: string): Request {
  return new Request(`https://example.com${pathname}`, {
    headers: { accept: "text/html" },
  });
}

function makeRequestContext(pathname: string): RequestContext<any> {
  const request = makeRequest(pathname);
  return createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any);
}

/** Let the loader's post-barrier continuation (and streamed pushes) settle. */
function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function foregroundMatch(pathname: string): Promise<RequestContext<any>> {
  const reqCtx = makeRequestContext(pathname);
  await runWithRequestContext(reqCtx, () =>
    router.match(makeRequest(pathname), { env: {} }),
  );
  await settle(50);
  return reqCtx;
}

async function captureMatch(
  reqCtx: RequestContext<any>,
  pathname: string,
): Promise<RequestContext<any>> {
  const { derivedCtx } = deriveShellCaptureContext(reqCtx, {
    ttl: 60,
    swr: 0,
  });
  await runWithRequestContext(derivedCtx, () =>
    router.match(makeRequest(pathname), { env: {} }),
  );
  await settle(50);
  return derivedCtx;
}

describe("PPR capture: render-barrier isolation (#684 plan 009)", () => {
  it("capture never executes a route loader — no capture-lane rendered() read exists", async () => {
    // CONTRACT CHANGE (streaming useLoader): route loaders are live at
    // capture unconditionally, loading() or not — masked, never executed.
    // The former bake-lane scenario this test pinned (a loader running
    // DURING capture and reading the capture's handle snapshot through its
    // own barrier) is unreachable by design now. The barrier-isolation
    // property itself is still covered by the lifecycle test below —
    // HANDLERS still run at capture and push into the capture's own store.
    const reqCtx = await foregroundMatch("/plain");

    // Foreground pass: barrier resolved, loader read the foreground push.
    expect(collected).toEqual([["render-1"]]);
    expect(reqCtx._renderBarrierHandleSnapshot).toBeDefined();

    await captureMatch(reqCtx, "/plain");

    // The capture's handler pushed render-2 into the CAPTURE's store, but the
    // masked loader never ran, so no capture-lane read was collected.
    expect(renderCounter).toBe(2);
    expect(collected).toEqual([["render-1"]]);
  });

  it("capture barrier lifecycle is its own: resolver, segment order, and streaming flag do not alias the foreground's", async () => {
    const reqCtx = await foregroundMatch("/plain");
    const foregroundOrder = reqCtx._renderBarrierSegmentOrder;
    const foregroundSnapshot = reqCtx._renderBarrierHandleSnapshot;

    const { derivedCtx } = deriveShellCaptureContext(reqCtx, {
      ttl: 60,
      swr: 0,
    });

    // Own wiring, not the prototype's: the resolver must be re-bound and the
    // barrier family reset as own properties at derivation time.
    expect(derivedCtx._resolveRenderBarrier).not.toBe(
      reqCtx._resolveRenderBarrier,
    );
    expect(
      Object.getOwnPropertyDescriptor(derivedCtx, "_renderBarrier"),
    ).toBeDefined();
    expect(derivedCtx._renderBarrierSegmentOrder).toBeUndefined();
    expect(derivedCtx._renderBarrierHandleSnapshot).toBeUndefined();
    expect(derivedCtx._treeHasStreaming).toBeUndefined();

    await runWithRequestContext(derivedCtx, () =>
      router.match(makeRequest("/plain"), { env: {} }),
    );
    await settle(50);

    // The capture resolved its OWN barrier (its segment order and snapshot are
    // own properties), and the foreground's state is untouched.
    expect(derivedCtx._renderBarrierSegmentOrder).toBeDefined();
    expect(derivedCtx._renderBarrierSegmentOrder).not.toBe(foregroundOrder);
    expect(derivedCtx._renderBarrierHandleSnapshot).not.toBe(
      foregroundSnapshot,
    );
    expect(derivedCtx._treeHasStreaming).toBe(false);
    expect(reqCtx._renderBarrierSegmentOrder).toBe(foregroundOrder);
    expect(reqCtx._renderBarrierHandleSnapshot).toBe(foregroundSnapshot);
  });

  it("resets _shellFragmentPayload as an own property: a capture render never inherits fragment passthrough", async () => {
    const reqCtx = await foregroundMatch("/plain");
    // A foreground that armed passthrough (document tail / partial replay
    // arming windows) must not leak envelopes into the capture: an envelope
    // reaching serializeSegments would bake a double-encoded fragment.
    reqCtx._shellFragmentPayload = true;

    const { derivedCtx } = deriveShellCaptureContext(reqCtx, {
      ttl: 60,
      swr: 0,
    });

    expect(
      Object.getOwnPropertyDescriptor(derivedCtx, "_shellFragmentPayload"),
    ).toBeDefined();
    expect(derivedCtx._shellFragmentPayload).toBe(false);
    expect(reqCtx._shellFragmentPayload).toBe(true);
  });

  it("on a streaming tree the capture recomputes _treeHasStreaming; its masked loader never reads", async () => {
    // CONTRACT CHANGE (streaming useLoader): as above, the capture masks the
    // route loader unconditionally, so no capture-lane rendered() read
    // happens on streaming trees either. The capture still recomputes
    // _treeHasStreaming for its OWN tree (own-property reset — the
    // isolation this file exists to pin), and the streaming slot's handler
    // still executes and pushes into the capture's store.
    const reqCtx = await foregroundMatch("/streaming");

    // Foreground pass: rendered() waited for the streaming slot to settle.
    expect(collected).toEqual([["stream-1"]]);
    expect(reqCtx._treeHasStreaming).toBe(true);

    const derivedCtx = await captureMatch(reqCtx, "/streaming");

    expect(derivedCtx._treeHasStreaming).toBe(true);
    expect(renderCounter).toBe(2);
    expect(collected).toEqual([["stream-1"]]);
  });

  it("foreground rendered() semantics are unchanged by the extraction (sanity)", async () => {
    const reqCtx = await foregroundMatch("/plain");

    expect(collected).toEqual([["render-1"]]);
    expect(reqCtx._renderBarrierSegmentOrder).toBeDefined();
    expect(reqCtx._renderBarrierGuardClosed).toBe(true);
    expect(reqCtx._renderBarrierWaiters).toBeUndefined();
  });
});
