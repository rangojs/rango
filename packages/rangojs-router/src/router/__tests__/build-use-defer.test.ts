import { describe, expect, it } from "vitest";
import {
  setupBuildUse,
  setupLoaderAccessSilent,
} from "../loader-resolution.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { createHandle } from "../../handle.js";
import type { HandlerContext } from "../../types";

// D2: setupBuildUse (the live prerender/build path) and setupLoaderAccessSilent
// (proactive-cache path) returned a BARE handle push with no .defer(), while the
// production setupLoaderAccess wraps its push with withDefer(...). A prerender
// handler calling `ctx.use(Handle).defer({...})` therefore threw
// `TypeError: ...defer is not a function` at build time. The fix wraps both bare
// pushes with withDefer so .defer() exists and behaves like production.

const Breadcrumbs = createHandle<{ label: string }>();

function makeReqCtx() {
  return createRequestContext<Record<string, never>>({
    env: {},
    request: new Request("http://localhost/"),
    url: new URL("http://localhost/"),
    variables: {},
  });
}

function makeCtx(segmentId: string): HandlerContext<any, any> {
  return { _currentSegmentId: segmentId } as unknown as HandlerContext<
    any,
    any
  >;
}

describe("setupBuildUse — ctx.use(Handle).defer() on the build path (D2)", () => {
  it("returns a push whose .defer() is callable and reserves a slot", async () => {
    const reqCtx = makeReqCtx();
    await runWithRequestContext(reqCtx, async () => {
      const ctx = makeCtx("R0");
      setupBuildUse(ctx);

      const push = ctx.use(Breadcrumbs);
      expect(typeof push).toBe("function");
      expect(typeof (push as { defer?: unknown }).defer).toBe("function");

      // Reserve the slot synchronously, then resolve it. Must not throw.
      const resolve = (
        push as { defer: (o?: unknown) => (v: unknown) => void }
      ).defer({ timeoutMs: 0 });
      resolve({ label: "Home" });

      // The deferred slot was pushed to the store under this segment.
      const segData = reqCtx._handleStore.getDataForSegment("R0");
      expect(Object.keys(segData)).toContain(Breadcrumbs.$$id);
    });
  });

  it("a direct (non-deferred) push still works on the build path", async () => {
    const reqCtx = makeReqCtx();
    await runWithRequestContext(reqCtx, async () => {
      const ctx = makeCtx("R0");
      setupBuildUse(ctx);
      const push = ctx.use(Breadcrumbs);
      push({ label: "Direct" });
      const segData = reqCtx._handleStore.getDataForSegment("R0");
      expect(segData[Breadcrumbs.$$id]).toEqual([{ label: "Direct" }]);
    });
  });
});

describe("setupLoaderAccessSilent — ctx.use(Handle).defer() in silent mode (D2)", () => {
  it("returns a no-op push whose .defer() is still callable (does not throw)", async () => {
    const reqCtx = makeReqCtx();
    await runWithRequestContext(reqCtx, async () => {
      const ctx = makeCtx("R0");
      setupLoaderAccessSilent(ctx, new Map());

      const push = ctx.use(Breadcrumbs);
      expect(typeof push).toBe("function");
      expect(typeof (push as { defer?: unknown }).defer).toBe("function");

      // Silent mode: the resolver is a no-op but .defer() must not throw.
      const resolve = (
        push as { defer: (o?: unknown) => (v: unknown) => void }
      ).defer({ timeoutMs: 0 });
      expect(() => resolve({ label: "Ignored" })).not.toThrow();

      // Nothing was pushed to the store (silent mode swallows handle data).
      expect(reqCtx._handleStore.getDataForSegment("R0")).toEqual({});
    });
  });
});
