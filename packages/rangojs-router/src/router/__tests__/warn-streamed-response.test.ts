import { describe, it, expect, vi, afterEach } from "vitest";
import { warnOnStreamedResponse } from "../segment-resolution/helpers.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("warnOnStreamedResponse (M9)", () => {
  it("warns when a streamed loading() handler rejects with a Response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnOnStreamedResponse(
      Promise.reject(new Response(null, { status: 302 })),
      "route0",
    );
    await flush();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("route0");
  });

  it("does not warn for ordinary handler errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnOnStreamedResponse(Promise.reject(new Error("boom")), "route0");
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn on a successful (non-Response) result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnOnStreamedResponse(Promise.resolve("ok"), "route0");
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });
});
