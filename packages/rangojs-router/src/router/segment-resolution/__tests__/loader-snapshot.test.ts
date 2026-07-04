import { describe, it, expect } from "vitest";
import {
  elideLoaderContainer,
  overlayLoaderContainer,
  isLoaderHoleMarker,
  LOADER_HOLE_KEY,
} from "../loader-snapshot.js";

const never = () => new Promise<never>(() => {});

describe("elideLoaderContainer", () => {
  it("passes primitives and plain containers through untouched", async () => {
    const r = await elideLoaderContainer({ a: 1, b: ["x", null], c: "s" });
    expect(r).toEqual({
      state: "ok",
      value: { a: 1, b: ["x", null], c: "s" },
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

  it("inlines a SETTLED nested promise (it baked — physics)", async () => {
    const r = await elideLoaderContainer({
      fast: Promise.resolve("won-the-window"),
    });
    expect(r).toEqual({
      state: "ok",
      value: { fast: "won-the-window" },
    });
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
});
