import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRevalidation } from "../revalidation.js";
import type { ResolvedSegment } from "../../types";

// D3: a revalidate fn is contracted SYNCHRONOUS (boolean |
// { defaultShouldRevalidate } | null/undefined). A Promise-returning (async) fn
// matches NONE of evaluateRevalidation's decision branches, so its async result
// is silently dropped and the default is kept — no error, no warning. The fix
// keeps the sync contract (does NOT await) but emits a dev-mode console.warn so
// the silent drop is diagnosable.

function makeSegment(): ResolvedSegment {
  return {
    id: "R0",
    type: "route",
    belongsToRoute: true,
    params: { id: "2" },
  } as unknown as ResolvedSegment;
}

function baseOptions(fn: any) {
  return {
    segment: makeSegment(),
    // Same params => no param change. Same search. So the NAV default for a
    // route segment is FALSE (nav:params-unchanged) — a stable baseline we can
    // assert the async fn does NOT flip.
    prevParams: { id: "2" },
    getPrevSegment: null,
    request: new Request("http://localhost/item/2"),
    prevUrl: new URL("http://localhost/item/2"),
    nextUrl: new URL("http://localhost/item/2"),
    revalidations: [{ name: "asyncRevalidate", fn }],
    routeKey: "item",
    context: {} as any,
  };
}

describe("evaluateRevalidation — async revalidate fn (D3)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns in dev and keeps the default when a revalidate fn returns a Promise", async () => {
    // An async fn: returns a Promise that (if it were awaited) would say true.
    // It must NOT flip the decision — the default (false) is kept — and a dev
    // warning must fire naming the offending fn.
    const asyncFn = vi.fn(async () => true);

    const result = await evaluateRevalidation(baseOptions(asyncFn));

    // Sync contract preserved: the thenable matched no branch; default kept.
    expect(result).toBe(false);
    expect(asyncFn).toHaveBeenCalledTimes(1);
    // Dev warning fired and is diagnosable (names the fn).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("asyncRevalidate");
    expect(msg).toContain("Promise");
  });

  it("does NOT warn for a well-formed synchronous fn", async () => {
    const syncFn = vi.fn(() => ({ defaultShouldRevalidate: true }));

    const result = await evaluateRevalidation(baseOptions(syncFn));

    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
