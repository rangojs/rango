import { describe, it, expect, vi } from "vitest";
import { collectHandle } from "../collect-handle.js";
import { createHandle } from "../../handle.js";

// collectHandle runs a handle's REAL registered collect on per-segment values.
// createHandle() with no injected id still registers its collect (via the runtime
// fallback id), so a consumer's handle is fully testable in a bare test.
describe("collectHandle", () => {
  it("runs the default flatten collect when no custom collect is given", () => {
    const Breadcrumbs = createHandle<{ label: string }>();
    const result = collectHandle(Breadcrumbs, [
      [{ label: "Home" }],
      [{ label: "Blog" }, { label: "Post" }],
    ]);
    expect(result).toEqual([
      { label: "Home" },
      { label: "Blog" },
      { label: "Post" },
    ]);
  });

  it("runs a custom 'last wins' collect", () => {
    const PageTitle = createHandle<string, string>(
      (segments) => segments.flat().at(-1) ?? "Default",
    );
    expect(collectHandle(PageTitle, [["Home"], ["Products"], ["Shoes"]])).toBe(
      "Shoes",
    );
    expect(collectHandle(PageTitle, [])).toBe("Default");
  });

  it("runs a custom 'object merge' collect (Meta-style)", () => {
    const Meta = createHandle<Record<string, string>, Record<string, string>>(
      (segments) => Object.assign({ robots: "index" }, ...segments.flat()),
    );
    expect(
      collectHandle(Meta, [[{ title: "Home" }], [{ title: "Post", og: "x" }]]),
    ).toEqual({ robots: "index", title: "Post", og: "x" });
  });

  it("runs a custom dedupe collect", () => {
    const Unique = createHandle<{ id: number }>((segments) => {
      const all = segments.flat();
      return all.filter(
        (item, i) => all.findIndex((x) => x.id === item.id) === i,
      );
    });
    const result = collectHandle(Unique, [
      [{ id: 1 }, { id: 2 }],
      [{ id: 1 }, { id: 3 }],
    ]);
    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("warns and flattens for a handle whose module never registered a collect", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A bare object masquerading as a handle with an unregistered id.
    const fake = { __brand: "handle" as const, $$id: "never-registered#X" };
    const result = collectHandle(fake as never, [[1], [2, 3]]);
    expect(result).toEqual([1, 2, 3]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
