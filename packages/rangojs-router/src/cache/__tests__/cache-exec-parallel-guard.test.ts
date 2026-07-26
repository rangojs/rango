/**
 * Regression test: the "use cache" cookies()/headers() guard must be scoped
 * to the cached function's own async chain, not to the shared RequestContext.
 *
 * Scar: registerCachedFunction stamped INSIDE_CACHE_EXEC on the ambient
 * RequestContext for the whole execution window of a cached body. A slow
 * "use cache" function (2s product fetch) running in PARALLEL with a sibling
 * loader on the same request poisoned the sibling's cookies() read — it threw
 * `cookies() cannot be called inside a "use cache" function` from code that
 * was nowhere near the cached function. Same shared-object hazard class as
 * issue #684 plan 010, which fixed only the background-revalidation path.
 *
 * Exercises the production registerCachedFunction through the same mocking
 * as cache-runtime-stale.test.ts (cache-runtime.ts imports @vitejs/plugin-rsc/rsc,
 * a virtual module not resolvable in vitest).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cookies, headers } from "../../server/cookie-store.js";

vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  encodeReply: vi.fn((args: unknown[]) =>
    Promise.resolve(JSON.stringify(args)),
  ),
  createClientTemporaryReferenceSet: vi.fn().mockReturnValue(new Set()),
}));

const mockGetRequestContext = vi.fn<() => any>(() => null);
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => mockGetRequestContext(),
  _getRequestContext: () => mockGetRequestContext(),
  runWithRequestContext: <T>(ctx: unknown, fn: () => T): T => {
    const prev = mockGetRequestContext.getMockImplementation();
    mockGetRequestContext.mockImplementation(() => ctx);
    try {
      return fn();
    } finally {
      mockGetRequestContext.mockImplementation(prev ?? (() => null));
    }
  },
}));

vi.mock("../segment-codec.js", () => ({
  serializeResult: vi.fn((v: any) => JSON.stringify(v)),
  deserializeResult: vi.fn((v: string) => JSON.parse(v)),
}));

vi.mock("../handle-snapshot.js", () => ({
  restoreHandles: vi.fn(),
  encodeHandles: vi.fn(async (h: any) => JSON.stringify(h)),
  decodeHandles: vi.fn(async (s: any) =>
    typeof s === "string" ? JSON.parse(s) : s,
  ),
}));

function makeRequestCtx() {
  return {
    _cacheStore: {
      getItem: vi.fn().mockResolvedValue(undefined),
      setItem: vi.fn().mockResolvedValue(undefined),
    },
    _cacheProfiles: { default: { ttl: 60 } },
    waitUntil: (fn: () => Promise<void>) => {
      void fn();
    },
    request: new Request("http://test.local/", {
      headers: { cookie: "session=abc" },
    }),
    cookie: (name: string) => (name === "session" ? "abc" : undefined),
    cookies: () => ({ session: "abc" }),
    setCookie: vi.fn(),
    deleteCookie: vi.fn(),
    headers: new Headers({ cookie: "session=abc" }),
  };
}

describe("use cache exec guard scoping", () => {
  let registerCachedFunction: typeof import("../cache-runtime.js").registerCachedFunction;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetRequestContext.mockReturnValue(null);
    const mod = await import("../cache-runtime.js");
    registerCachedFunction = mod.registerCachedFunction;
  });

  it("cookies() in PARALLEL code does not throw while a cached body is in flight", async () => {
    const ctx = makeRequestCtx();
    mockGetRequestContext.mockReturnValue(ctx);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cached = registerCachedFunction(
      async (key: string) => {
        await gate;
        return `value:${key}`;
      },
      "parallel-guard-fn",
      "default",
    );

    const inFlight = cached("k");
    // Let the miss path reach the body (getItem await, stamp, kickoff).
    await new Promise((r) => setTimeout(r, 10));

    // The parallel read: same request, different async chain. This is a
    // loader reading cookies() while an unrelated "use cache" fetch runs.
    expect(() => cookies()).not.toThrow();
    expect(() => headers()).not.toThrow();
    expect(cookies().get("session")?.value).toBe("abc");

    release();
    await expect(inFlight).resolves.toBe("value:k");

    // Guard state fully unwound after completion.
    expect(() => cookies()).not.toThrow();
  });

  it("cookies() INSIDE the cached body still throws", async () => {
    const ctx = makeRequestCtx();
    mockGetRequestContext.mockReturnValue(ctx);

    const cached = registerCachedFunction(
      async () => {
        cookies();
        return "never";
      },
      "in-body-read-fn",
      "default",
    );

    await expect(cached()).rejects.toThrow(
      /cookies\(\) cannot be called inside a "use cache" function/,
    );
  });

  it("headers() INSIDE the cached body still throws", async () => {
    const ctx = makeRequestCtx();
    mockGetRequestContext.mockReturnValue(ctx);

    const cached = registerCachedFunction(
      async () => {
        headers();
        return "never";
      },
      "in-body-headers-fn",
      "default",
    );

    await expect(cached()).rejects.toThrow(
      /headers\(\) cannot be called inside a "use cache" function/,
    );
  });
});
