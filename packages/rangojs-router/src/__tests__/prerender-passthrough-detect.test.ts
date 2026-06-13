import { describe, it, expect } from "vitest";
import {
  detectPrerenderPassthrough,
  PRERENDER_PASSTHROUGH,
} from "../prerender.js";

describe("detectPrerenderPassthrough", () => {
  it("detects a synchronous sentinel component", async () => {
    expect(
      await detectPrerenderPassthrough([{ component: PRERENDER_PASSTHROUGH }]),
    ).toBe(true);
  });

  // Regression M16: when a route declares loading(), the build handler result is
  // deferred, so the segment component is a Promise resolving to the sentinel. A
  // synchronous isPrerenderPassthrough(component) on the Promise returned false,
  // and the build baked a corrupt artifact instead of deferring to the live
  // Passthrough handler.
  it("detects a sentinel wrapped in a Promise (loading() deferral)", async () => {
    expect(
      await detectPrerenderPassthrough([
        { component: Promise.resolve(PRERENDER_PASSTHROUGH) },
      ]),
    ).toBe(true);
  });

  it("returns false for ordinary sync and async components", async () => {
    expect(
      await detectPrerenderPassthrough([
        { component: { type: "div" } },
        { component: Promise.resolve({ type: "span" }) },
        { component: null },
      ]),
    ).toBe(false);
  });

  it("ignores a rejected component thenable (the error resurfaces during serialization)", async () => {
    const rejected = Promise.reject(new Error("boom"));
    rejected.catch(() => {}); // keep the test runner from flagging unhandled rejection
    expect(await detectPrerenderPassthrough([{ component: rejected }])).toBe(
      false,
    );
  });
});
