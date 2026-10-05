/**
 * scheduleOverlayRevalidation's per-isolate dedup: a key is held only while its
 * onRevalidate is in flight, and never longer than IN_FLIGHT_LEADER_MAX_WAIT_MS
 * (a never-settling call must not pin the key for the isolate's lifetime).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../prerender/store.js", () => ({
  createPrerenderStore: () => ({ get: async () => null }),
}));

import {
  resetOverlayRevalidationsForTests,
  scheduleOverlayRevalidation,
} from "../cache-lookup.js";
import { IN_FLIGHT_LEADER_MAX_WAIT_MS } from "../../../cache/cache-policy.js";
import type { PrerenderTargetObject } from "../../../prerender/on-demand.js";
import type { RequestContext } from "../../../server/request-context.js";

const target = {
  route: "hot",
  params: { slug: "a" },
} as unknown as PrerenderTargetObject;

function reqCtx(build = false) {
  const tasks: Promise<void>[] = [];
  const ctx = {
    build,
    env: {},
    waitUntil: vi.fn((fn: () => Promise<void>) => {
      if (build) return;
      tasks.push(fn());
    }),
  } as unknown as RequestContext<any>;
  return { ctx, tasks };
}

describe("scheduleOverlayRevalidation", () => {
  afterEach(() => resetOverlayRevalidationsForTests());

  it("dedupes while in flight and frees the key when the task settles", async () => {
    let release!: () => void;
    const onRevalidate = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const { ctx, tasks } = reqCtx();

    scheduleOverlayRevalidation("k", onRevalidate, target, ctx, 0);
    scheduleOverlayRevalidation("k", onRevalidate, target, ctx, 1000);
    await Promise.resolve();
    expect(onRevalidate).toHaveBeenCalledTimes(1);

    release();
    await Promise.all(tasks);
    scheduleOverlayRevalidation("k", onRevalidate, target, ctx, 2000);
    await Promise.resolve();
    expect(onRevalidate).toHaveBeenCalledTimes(2);
  });

  it("treats an entry older than the in-flight cap as free", async () => {
    const onRevalidate = vi.fn(() => new Promise<void>(() => {}));
    const { ctx } = reqCtx();

    scheduleOverlayRevalidation("k", onRevalidate, target, ctx, 0);
    scheduleOverlayRevalidation(
      "k",
      onRevalidate,
      target,
      ctx,
      IN_FLIGHT_LEADER_MAX_WAIT_MS - 1,
    );
    await Promise.resolve();
    expect(onRevalidate).toHaveBeenCalledTimes(1);

    scheduleOverlayRevalidation(
      "k",
      onRevalidate,
      target,
      ctx,
      IN_FLIGHT_LEADER_MAX_WAIT_MS,
    );
    await Promise.resolve();
    expect(onRevalidate).toHaveBeenCalledTimes(2);
  });

  it("does not schedule under a build context", async () => {
    const onRevalidate = vi.fn(async () => {});
    const { ctx } = reqCtx(true);

    scheduleOverlayRevalidation("k", onRevalidate, target, ctx, 0);
    expect(ctx.waitUntil).not.toHaveBeenCalled();

    // Nothing was pinned: a live request right after schedules.
    const live = reqCtx();
    scheduleOverlayRevalidation("k", onRevalidate, target, live.ctx, 1);
    await Promise.all(live.tasks);
    expect(onRevalidate).toHaveBeenCalledTimes(1);
  });

  it("resetOverlayRevalidationsForTests clears pinned keys", async () => {
    const onRevalidate = vi.fn(() => new Promise<void>(() => {}));
    const { ctx } = reqCtx();
    scheduleOverlayRevalidation("k", onRevalidate, target, ctx, 0);
    resetOverlayRevalidationsForTests();
    scheduleOverlayRevalidation("k", onRevalidate, target, ctx, 1);
    await Promise.resolve();
    expect(onRevalidate).toHaveBeenCalledTimes(2);
  });
});
