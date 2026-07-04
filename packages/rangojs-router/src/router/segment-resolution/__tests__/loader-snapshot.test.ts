import { describe, it, expect } from "vitest";
import {
  elideLoaderContainer,
  overlayLoaderContainer,
  isLoaderHoleMarker,
  isLoaderSettledMarker,
  LOADER_HOLE_KEY,
  LOADER_SETTLED_KEY,
} from "../loader-snapshot.js";

const never = () => new Promise<never>(() => {});

describe("elideLoaderContainer", () => {
  it("passes primitives and plain containers through untouched", async () => {
    const r = await elideLoaderContainer({ a: 1, b: ["x", null], c: "s" });
    expect(r).toEqual({
      state: "ok",
      value: { a: 1, b: ["x", null], c: "s" },
      hasHole: false,
    });
  });

  it("replaces a PENDING nested promise with a hole marker", async () => {
    const r = await elideLoaderContainer({ static: "baked", dynamic: never() });
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    const v = r.value as Record<string, unknown>;
    expect(v.static).toBe("baked");
    expect(isLoaderHoleMarker(v.dynamic)).toBe(true);
  });

  it("records a SETTLED nested promise as a settled marker (value pinned, promise shape remembered, no holes bit)", async () => {
    const r = await elideLoaderContainer({
      fast: Promise.resolve("won-the-window"),
    });
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    const fast = (r.value as Record<string, unknown>).fast;
    expect(isLoaderSettledMarker(fast)).toBe(true);
    expect((fast as { value: unknown }).value).toBe("won-the-window");
    // Fully-pinned marker: no capture-computed holes bit.
    expect((fast as { holes?: 1 }).holes).toBeUndefined();
  });

  it("a settled nested promise resolving to a container keeps deeper holes and stamps the holes bit", async () => {
    const r = await elideLoaderContainer({
      section: Promise.resolve({ title: "baked", stream: never() }),
    });
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    const section = (r.value as Record<string, unknown>).section as {
      value: Record<string, unknown>;
      holes?: 1;
    };
    expect(isLoaderSettledMarker(section)).toBe(true);
    expect(section.value.title).toBe("baked");
    expect(isLoaderHoleMarker(section.value.stream)).toBe(true);
    // Capture-computed: the overlay picks its rehydration path from this bit
    // instead of rescanning the pinned subtree on every HIT.
    expect(section.holes).toBe(1);
  });

  it("unwraps a settled top-level container promise", async () => {
    const r = await elideLoaderContainer(Promise.resolve({ a: 1, p: never() }));
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect((r.value as Record<string, unknown>).a).toBe(1);
    expect(isLoaderHoleMarker((r.value as Record<string, unknown>).p)).toBe(
      true,
    );
  });

  it("reports a REJECTED promise (top-level or nested) as rejected", async () => {
    const rejected = Promise.reject(new Error("boom"));
    rejected.catch(() => {});
    expect(await elideLoaderContainer(rejected)).toEqual({
      state: "rejected",
    });
    const nested = Promise.reject(new Error("boom"));
    nested.catch(() => {});
    expect(await elideLoaderContainer({ x: nested })).toEqual({
      state: "rejected",
    });
  });

  it("treats non-plain objects (Date, Map, class) as pinned leaves", async () => {
    const d = new Date(0);
    const m = new Map([["k", "v"]]);
    const r = await elideLoaderContainer({ d, m });
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect((r.value as Record<string, unknown>).d).toBe(d);
    expect((r.value as Record<string, unknown>).m).toBe(m);
  });
});

describe("overlayLoaderContainer", () => {
  it("recorded paths win; marker paths take the fresh value", () => {
    const freshPromise = never();
    const fresh = { static: "fresh-drifted", dynamic: freshPromise };
    const recorded = {
      static: "capture-pinned",
      dynamic: { [LOADER_HOLE_KEY]: 1 },
    };
    const out = overlayLoaderContainer(fresh, recorded) as Record<
      string,
      unknown
    >;
    expect(out.static).toBe("capture-pinned");
    expect(out.dynamic).toBe(freshPromise);
  });

  it("fresh-only keys pass through (they never rendered into the prelude)", () => {
    const out = overlayLoaderContainer(
      { kept: "recorded?", added: "new-at-hit" },
      { kept: "recorded!" },
    ) as Record<string, unknown>;
    expect(out.kept).toBe("recorded!");
    expect(out.added).toBe("new-at-hit");
  });

  it("recurses through arrays by index", () => {
    const p = never();
    const out = overlayLoaderContainer(
      [{ v: "fresh" }, p],
      [{ v: "pinned" }, { [LOADER_HOLE_KEY]: 1 }],
    ) as unknown[];
    expect((out[0] as Record<string, unknown>).v).toBe("pinned");
    expect(out[1]).toBe(p);
  });

  it("shape drift: recorded wins wholesale; a marker with no fresh value falls back to undefined", () => {
    // Recorded an object, fresh run returned a primitive.
    const out = overlayLoaderContainer("not-an-object", {
      a: "pinned",
      hole: { [LOADER_HOLE_KEY]: 1 },
    }) as Record<string, unknown>;
    expect(out.a).toBe("pinned");
    expect(out.hole).toBeUndefined();
    // Recorded a primitive, fresh returned an object: recorded wins.
    expect(overlayLoaderContainer({ a: 1 }, "pinned")).toBe("pinned");
  });

  it("marker at the root takes the whole fresh value", () => {
    const p = never();
    expect(overlayLoaderContainer(p, { [LOADER_HOLE_KEY]: 1 })).toBe(p);
  });

  // Regression: the storefront PDP crashed with React #438 on every shell HIT.
  // A nested promise (prices) settled inside the capture window, was recorded
  // as its raw value, and the overlay handed that plain object to a component
  // whose code is `use(data.prices)` — use() requires a thenable. The settled
  // marker must rehydrate as Promise.resolve(pinned).
  it("rehydrates a settled marker as a PROMISE of the pinned value (#438 regression)", async () => {
    const fresh = { prices: never() };
    const recorded = {
      prices: { [LOADER_SETTLED_KEY]: 1, value: { SKU1: { price: 60 } } },
    };
    const out = overlayLoaderContainer(fresh, recorded) as {
      prices: unknown;
    };
    expect(typeof (out.prices as PromiseLike<unknown>)?.then).toBe("function");
    await expect(out.prices).resolves.toEqual({ SKU1: { price: 60 } });
  });

  it("a fully-pinned settled marker resolves immediately — not gated on fresh latency", async () => {
    // fresh never resolves; the pinned value must still come through.
    const out = overlayLoaderContainer(
      { section: never() },
      { section: { [LOADER_SETTLED_KEY]: 1, value: "pinned" } },
    ) as { section: Promise<unknown> };
    await expect(out.section).resolves.toBe("pinned");
  });

  it("deep holes inside a settled marker fill from the fresh promise's resolution", async () => {
    const liveStream = never();
    const fresh = {
      section: Promise.resolve({ title: "fresh-title", stream: liveStream }),
    };
    const recorded = {
      section: {
        [LOADER_SETTLED_KEY]: 1,
        value: { title: "pinned-title", stream: { [LOADER_HOLE_KEY]: 1 } },
        holes: 1,
      },
    };
    const out = overlayLoaderContainer(fresh, recorded) as {
      section: Promise<{ title: string; stream: unknown }>;
    };
    const section = await out.section;
    expect(section.title).toBe("pinned-title");
    expect(section.stream).toBe(liveStream);
  });

  it("a rejecting fresh run degrades settled-marker holes to undefined without poisoning the pin", async () => {
    const rejecting = Promise.reject(new Error("fresh boom"));
    rejecting.catch(() => {});
    const out = overlayLoaderContainer(
      { section: rejecting },
      {
        section: {
          [LOADER_SETTLED_KEY]: 1,
          value: { title: "pinned", stream: { [LOADER_HOLE_KEY]: 1 } },
          holes: 1,
        },
      },
    ) as { section: Promise<{ title: string; stream: unknown }> };
    const section = await out.section;
    expect(section.title).toBe("pinned");
    expect(section.stream).toBeUndefined();
  });

  it("elide output round-trips through overlay: pinned parts frozen, deep hole filled from fresh", async () => {
    const captured = await elideLoaderContainer(
      Promise.resolve({
        section: Promise.resolve({ title: "capture-title", stream: never() }),
      }),
    );
    expect(captured.state).toBe("ok");
    if (captured.state !== "ok") return;

    const liveStream = never();
    const out = overlayLoaderContainer(
      {
        section: Promise.resolve({ title: "fresh-title", stream: liveStream }),
      },
      captured.value,
    ) as { section: Promise<{ title: string; stream: unknown }> };
    const section = await out.section;
    expect(section.title).toBe("capture-title");
    expect(section.stream).toBe(liveStream);
  });

  it("nested settled markers rehydrate as nested promises", async () => {
    const out = overlayLoaderContainer(undefined, {
      [LOADER_SETTLED_KEY]: 1,
      value: {
        inner: { [LOADER_SETTLED_KEY]: 1, value: "deep-pinned" },
      },
    }) as Promise<{ inner: Promise<string> }>;
    const resolved = await out;
    expect(typeof resolved.inner?.then).toBe("function");
    await expect(resolved.inner).resolves.toBe("deep-pinned");
  });
});
