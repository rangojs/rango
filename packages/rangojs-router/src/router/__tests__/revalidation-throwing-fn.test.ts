// Fail-open contract: a user revalidate() fn that THROWS must not reject
// evaluateRevalidation (which would collapse the whole entry's loader batch
// into a failed partial render). A throw is logged and treated as "defer to
// current default", leaving the running suggestion unchanged and continuing
// the chain — mirroring the dynamic-tags fail-open in cache-policy.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logging.js", () => ({
  debugLog: vi.fn(),
  pushRevalidationTraceEntry: vi.fn(),
  isTraceActive: () => false,
}));

vi.mock("../../server/request-context.js", () => ({
  _getRequestContext: () => ({ _prevRouteKey: undefined }),
}));

import { evaluateRevalidation } from "../revalidation.js";

function makeSegment(overrides?: Partial<any>): any {
  return {
    id: "seg-1",
    type: "route",
    params: {},
    belongsToRoute: true,
    ...overrides,
  };
}

function makeContext(): any {
  return {
    request: new Request("http://localhost/test"),
    env: {},
    params: {},
    pathname: "/test",
    url: new URL("http://localhost/test"),
    var: {},
    get: vi.fn(),
    set: vi.fn(),
    header: vi.fn(),
    use: vi.fn(),
  };
}

// Drive evaluateRevalidation for a plain (GET) navigation on a route segment.
// prevParams/nextUrl control the policy seed: equal params + same search ->
// "nav:params-unchanged" -> seed false; differing params -> seed true.
function run(
  revalidations: Array<{ name: string; fn: any }>,
  opts?: {
    prevParams?: Record<string, string>;
    nextParams?: Record<string, string>;
  },
): Promise<boolean> {
  const prevParams = opts?.prevParams ?? {};
  const nextParams = opts?.nextParams ?? {};
  return evaluateRevalidation({
    segment: makeSegment({ params: nextParams }),
    prevParams,
    getPrevSegment: null,
    request: new Request("http://localhost/test"),
    prevUrl: new URL("http://localhost/test"),
    nextUrl: new URL("http://localhost/test"),
    revalidations,
    routeKey: "test",
    context: makeContext(),
  });
}

describe("evaluateRevalidation fails open when a revalidate fn throws", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("(a) a single throwing fn resolves to the default decision (does not reject)", async () => {
    // Seed false: equal params, same URL -> "nav:params-unchanged".
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const decisionFalse = await run([{ name: "throwing", fn: throwing }]);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(decisionFalse).toBe(false);

    // Seed true: changed params -> "nav:params-changed". The throw is
    // transparent, so the default still flows through.
    throwing.mockClear();
    const decisionTrue = await run([{ name: "throwing", fn: throwing }], {
      prevParams: { id: "1" },
      nextParams: { id: "2" },
    });
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(decisionTrue).toBe(true);

    // Fail open means it logs rather than throws.
    expect(errorSpy).toHaveBeenCalled();
  });

  it("(b) a throw does not prevent the next fn from running; final reflects the second", async () => {
    // Seed false; the second fn soft-returns true and must still be reached.
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const softTrue = vi.fn(() => ({ defaultShouldRevalidate: true }));

    const decision = await run([
      { name: "throwing", fn: throwing },
      { name: "softTrue", fn: softTrue },
    ]);

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(softTrue).toHaveBeenCalledTimes(1);
    expect(decision).toBe(true);
  });

  it("(c) a thrown Response is control flow and is re-thrown, not swallowed", async () => {
    // `throw redirect(...)` from a revalidate fn must reach the handler
    // chokepoint, not be flattened into a default decision. The fail-open
    // catch re-throws `error instanceof Response`.
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "/login" },
    });
    const fn = vi.fn(() => {
      throw redirect;
    });
    await expect(run([{ name: "auth", fn }])).rejects.toBe(redirect);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // Case (d) — driving a throwing `revalidate` through the public
  // renderRoute/dispatch testing primitives would require new plumbing: those
  // primitives expose no way to declare a route entry's revalidate array or to
  // supply the prev-URL / clientSegmentIds a client navigation needs to reach
  // evaluateRevalidation. Per the plan this is skipped rather than adding
  // plumbing. The closest userland-shaped coverage already exists in
  // parallel-revalidate-fns-invocation.test.ts, which drives the real
  // segment-resolution callers.
});
