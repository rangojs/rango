/**
 * gateOnDemandProducer: when the retained producer of a plain
 * `Prerender(..., { onDemand })` route may render inside a request. Never in
 * production (a miss is a 404); in dev on a miss (the documented live
 * fall-through), except for a page the overlay marks removed, which is a 404
 * in dev as in production (#1060).
 */
import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ dev: false }));
vi.mock("../../errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../errors.js")>()),
  isDevEnvironment: () => env.dev,
}));

import { gateOnDemandProducer } from "../path-helper.js";
import { DataNotFoundError } from "../../errors.js";
import type { Handler } from "../../types.js";

const producer = vi.fn(() => "page") as unknown as Handler<any, any, unknown>;
const gated = gateOnDemandProducer(producer, true);
/** A request's handler context; `build` is true only for a producer run. */
const call = (ctx: Record<string, unknown>) =>
  gated(ctx as unknown as Parameters<typeof gated>[0]);

describe("gateOnDemandProducer", () => {
  it("is the producer itself for a route that is not on-demand", () => {
    expect(gateOnDemandProducer(producer, false)).toBe(producer);
  });

  it("production: a request never renders the producer, a producer run does", () => {
    env.dev = false;
    expect(() => call({})).toThrow(DataNotFoundError);
    expect(() => call({ _prerenderRemoved: true })).toThrow(DataNotFoundError);
    expect(call({ build: true })).toBe("page");
  });

  it("dev: a request for a page with no entry renders live", () => {
    env.dev = true;
    expect(call({})).toBe("page");
    expect(call({ build: true })).toBe("page");
  });

  it("dev: a request for a removed page is a 404, not a live render of it", () => {
    env.dev = true;
    expect(() => call({ _prerenderRemoved: true })).toThrow(DataNotFoundError);
  });
});
