import { describe, it, expect } from "vitest";
import {
  detectPrerenderPassthrough,
  findPrerenderResponseSegments,
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

// A parallel slot handler's Response is not thrown by the resolution, so the
// on-demand producer looks for it on the resolved segments, holds those
// segments out of the payload and throws the Response after the encode.
describe("findPrerenderResponseSegments", () => {
  const redirect = new Response(null, {
    status: 302,
    headers: { location: "/login" },
  });
  const unauthorized = new Response("nope", { status: 401 });

  it("finds the segment a synchronous Response component sits on", async () => {
    const slot = { id: "s1", component: redirect as unknown };
    expect(
      await findPrerenderResponseSegments([
        { id: "s0", component: { type: "div" } },
        slot,
      ]),
    ).toEqual([{ segment: slot, response: redirect }]);
  });

  it("finds one wrapped in a Promise (a slot behind loading())", async () => {
    const slot = { id: "s1", component: Promise.resolve(redirect) };
    expect(
      await findPrerenderResponseSegments([
        { id: "s0", component: { type: "div" } },
        slot,
      ]),
    ).toEqual([{ segment: slot, response: redirect }]);
  });

  it("returns every one, so the caller can prefer a failure over a redirect", async () => {
    const first = { id: "s0", component: redirect as unknown };
    const second = { id: "s1", component: unauthorized as unknown };
    expect(await findPrerenderResponseSegments([first, second])).toEqual([
      { segment: first, response: redirect },
      { segment: second, response: unauthorized },
    ]);
  });

  it("returns none for ordinary components or a rejected thenable", async () => {
    const rejected = Promise.reject(new Error("boom"));
    rejected.catch(() => {});
    expect(
      await findPrerenderResponseSegments([
        { id: "s0", component: { type: "div" } },
        { id: "s1", component: null },
        { id: "s2", component: rejected },
      ]),
    ).toEqual([]);
  });
});
