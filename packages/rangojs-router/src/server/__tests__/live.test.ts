import { describe, it, expect } from "vitest";
import { live } from "../live.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../request-context.js";

/** True iff the promise settles within `ms`. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
}

function makeCtx(shellCaptureRun: boolean): RequestContext {
  const ctx = createRequestContext({
    env: {},
    request: new Request("https://example.com/"),
    url: new URL("https://example.com/"),
    variables: {},
  }) as RequestContext;
  // The ACTIVE capture marker — only the background derived context sets it.
  if (shellCaptureRun)
    (ctx as { _shellCaptureRun?: boolean })._shellCaptureRun = true;
  return ctx;
}

describe("live() outside shell capture (passthrough)", () => {
  it("runs the thunk and resolves to its value", async () => {
    let invoked = 0;
    const p = live(() => {
      invoked += 1;
      return Promise.resolve("V");
    });
    // Thunk ran eagerly (no capture) ...
    expect(invoked).toBe(1);
    await expect(p).resolves.toBe("V");
  });

  it("wraps a non-promise thunk return in a promise", async () => {
    await expect(live(() => 42)).resolves.toBe(42);
  });

  it("passes a promise through UNCHANGED (value form)", async () => {
    const original = Promise.resolve("X");
    expect(live(original)).toBe(original);
    await expect(live(original)).resolves.toBe("X");
  });

  it("passthrough holds inside a NON-capture request context", async () => {
    let invoked = 0;
    await runWithRequestContext(makeCtx(false), async () => {
      const p = live(() => {
        invoked += 1;
        return Promise.resolve("R");
      });
      expect(invoked).toBe(1);
      await expect(p).resolves.toBe("R");
    });
  });
});

describe("live() inside shell capture (deterministic hole)", () => {
  it("thunk form: does NOT invoke the thunk and returns a never-settling hole", async () => {
    let invoked = 0;
    let hole!: Promise<unknown>;
    runWithRequestContext(makeCtx(true), () => {
      hole = live(() => {
        invoked += 1;
        return Promise.resolve("SHOULD-NOT-RUN");
      });
    });
    // The thunk never fires during capture — no fetch, no cost.
    expect(invoked).toBe(0);
    // The hole never settles: the capture abort, not the promise, ends the
    // render. (This is the reintroduce-a-resolve-path regression guard.)
    expect(await settlesWithin(hole, 40)).toBe(false);
  });

  it("value form: discards the passed promise and returns a never-settling hole", async () => {
    let settledOriginal = false;
    const original = Promise.resolve("REAL").then((v) => {
      settledOriginal = true;
      return v;
    });
    let hole!: Promise<unknown>;
    runWithRequestContext(makeCtx(true), () => {
      hole = live(original);
    });
    // The returned promise is the hole, NOT the original.
    expect(hole).not.toBe(original);
    expect(await settlesWithin(hole, 40)).toBe(false);
    // Documented caveat: with the value form the work already fired, so the
    // original promise still settles even though its result is held out of the
    // shell. Prefer the thunk form to avoid the work entirely.
    expect(settledOriginal).toBe(true);
  });
});

describe("live() cache-boundary guards", () => {
  it('throws inside a "use cache" function context', async () => {
    const { INSIDE_CACHE_EXEC } = await import("../../cache/taint.js");
    const ctx = makeCtx(false);
    (ctx as any)[INSIDE_CACHE_EXEC] = true;
    runWithRequestContext(ctx, () => {
      expect(() => live(() => Promise.resolve(1))).toThrow(
        /cannot be called inside a "use cache" function/i,
      );
    });
  });

  it("throws inside a cache() DSL scope", async () => {
    const { RangoContext } = await import("../context.js");
    const ctx = makeCtx(false);
    runWithRequestContext(ctx, () => {
      RangoContext.run({ insideCacheScope: true } as any, () => {
        expect(() => live(() => Promise.resolve(1))).toThrow(
          /cannot be called inside a cache\(\) boundary/i,
        );
      });
    });
  });

  it("error messages point at loaders as the live lane", async () => {
    const { RangoContext } = await import("../context.js");
    const ctx = makeCtx(false);
    runWithRequestContext(ctx, () => {
      RangoContext.run({ insideCacheScope: true } as any, () => {
        expect(() => live(() => 1)).toThrow(/loader/i);
      });
    });
  });

  it("passes through normally in a plain request context (no boundary)", async () => {
    const ctx = makeCtx(false);
    await runWithRequestContext(ctx, async () => {
      await expect(live(() => Promise.resolve("ok"))).resolves.toBe("ok");
    });
  });
});
