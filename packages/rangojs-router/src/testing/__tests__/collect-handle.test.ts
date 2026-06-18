import { describe, it, expect, vi } from "vitest";
import { collectHandle } from "../collect-handle.js";
import { createHandle } from "../../handle.js";
import { Meta } from "../../handles/meta.js";
import { Breadcrumbs } from "../../handles/breadcrumbs.js";

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

  it("drops empty per-segment arrays before the collect runs (production parity)", () => {
    // Production collectHandleData (handle.ts) only passes segments that pushed
    // something. A collect that inspects segment count must see the same input,
    // so a segment that pushed nothing (empty array) must NOT appear.
    const SegmentCount = createHandle<string, number>((segments) => {
      return segments.length;
    });
    // Three segments, but the middle one pushed nothing.
    expect(collectHandle(SegmentCount, [["a"], [], ["b"]])).toBe(2);
    expect(collectHandle(SegmentCount, [[], [], []])).toBe(0);
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

// Coverage of the SHIPPED built-in handles' accumulators. collectMeta /
// collectBreadcrumbs are internal (not exported), so collectHandle is the only
// way to unit-test them — exactly the accumulator logic a consumer relies on.
describe("collectHandle on the built-in Breadcrumbs handle", () => {
  const home = { label: "Home", href: "/" };
  const blog = { label: "Blog", href: "/blog" };

  it("flattens breadcrumb items across segments in parent -> child order", () => {
    expect(collectHandle(Breadcrumbs, [[home], [blog]])).toEqual([home, blog]);
  });

  it("dedupes by href, keeping the last occurrence", () => {
    const homeV2 = { label: "Home (current)", href: "/" };
    expect(collectHandle(Breadcrumbs, [[home], [homeV2], [blog]])).toEqual([
      homeV2,
      blog,
    ]);
  });

  it("returns an empty array for no segments", () => {
    expect(collectHandle(Breadcrumbs, [])).toEqual([]);
  });
});

describe("collectHandle on the built-in Meta handle", () => {
  // Helper: find the resolved title string in the collected descriptors.
  const titleOf = (segs: Array<Array<Record<string, unknown>>>): unknown =>
    (collectHandle(Meta, segs as never) as Array<Record<string, unknown>>).find(
      (d) => "title" in d,
    )?.title;

  it("includes the default descriptors (charSet + viewport)", () => {
    const result = collectHandle(Meta, [[{ title: "Home" }]] as never) as Array<
      Record<string, unknown>
    >;
    expect(result).toContainEqual({ charSet: "utf-8" });
    expect(result).toContainEqual({
      name: "viewport",
      content: "width=device-width, initial-scale=1",
    });
    expect(result).toContainEqual({ title: "Home" });
  });

  it("lets a child title override a parent title (last wins)", () => {
    expect(titleOf([[{ title: "Parent" }], [{ title: "Child" }]])).toBe(
      "Child",
    );
  });

  it("applies a parent title template (%s) to a child string title", () => {
    expect(
      titleOf([
        [{ title: { template: "%s | Acme", default: "Acme" } }],
        [{ title: "Product" }],
      ]),
    ).toBe("Product | Acme");
  });

  it("uses the template's default when no child title is pushed", () => {
    expect(
      titleOf([[{ title: { template: "%s | Acme", default: "Acme" } }]]),
    ).toBe("Acme");
  });

  it("inserts a child title containing $-sequences literally into the template", () => {
    // String.prototype.replace would interpret $&, $', $`, $$, $n in the
    // replacement; the template must insert the raw title verbatim.
    expect(
      titleOf([
        [{ title: { template: "%s | Acme", default: "Acme" } }],
        [{ title: "Save $5 & more" }],
      ]),
    ).toBe("Save $5 & more | Acme");
    expect(
      titleOf([
        [{ title: { template: "%s | Acme", default: "Acme" } }],
        [{ title: "Buy $& now" }],
      ]),
    ).toBe("Buy $& now | Acme");
    expect(
      titleOf([
        [{ title: { template: "%s | Acme", default: "Acme" } }],
        [{ title: "100$$ deal" }],
      ]),
    ).toBe("100$$ deal | Acme");
    expect(
      titleOf([
        [{ title: { template: "%s | Acme", default: "Acme" } }],
        [{ title: "a$'b" }],
      ]),
    ).toBe("a$'b | Acme");
  });

  it("an absolute title bypasses the template", () => {
    expect(
      titleOf([
        [{ title: { template: "%s | Acme", default: "Acme" } }],
        [{ title: { absolute: "Exact Title" } }],
      ]),
    ).toBe("Exact Title");
  });

  it("merges/overrides keyed descriptors (e.g. property:og:title)", () => {
    const result = collectHandle(Meta, [
      [{ property: "og:title", content: "A" }],
      [{ property: "og:title", content: "B" }],
    ] as never) as Array<Record<string, unknown>>;
    const og = result.filter((d) => d.property === "og:title");
    expect(og).toEqual([{ property: "og:title", content: "B" }]);
  });

  it("unset removes a previously-added descriptor by key", () => {
    const result = collectHandle(Meta, [
      [{ name: "description", content: "hello" }],
      [{ unset: "name:description" }],
    ] as never) as Array<Record<string, unknown>>;
    expect(result.some((d) => d.name === "description")).toBe(false);
  });

  describe("JSON-LD (script:ld+json)", () => {
    const ldBlocks = (segs: unknown): unknown[] =>
      (collectHandle(Meta, segs as never) as Array<Record<string, unknown>>)
        .filter((d) => "script:ld+json" in d)
        .map((d) => d["script:ld+json"]);

    it("collects a single JSON-LD block", () => {
      const product = {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Widget",
      };
      expect(ldBlocks([[{ "script:ld+json": product }]])).toEqual([product]);
    });

    it("keeps MULTIPLE JSON-LD blocks across segments (not deduped) — the multi-JSON-LD option", () => {
      const product = { "@type": "Product", name: "Widget" };
      const crumbs = { "@type": "BreadcrumbList", itemListElement: [] };
      expect(
        ldBlocks([
          [{ "script:ld+json": product }],
          [{ "script:ld+json": crumbs }],
        ]),
      ).toEqual([product, crumbs]);
    });

    it("keeps multiple JSON-LD blocks pushed within the SAME segment", () => {
      const org = { "@type": "Organization", name: "Acme" };
      const site = { "@type": "WebSite", url: "https://acme.test" };
      expect(
        ldBlocks([[{ "script:ld+json": org }, { "script:ld+json": site }]]),
      ).toEqual([org, site]);
    });

    it("does NOT dedupe two identical-@type JSON-LD blocks (unlike name/property meta)", () => {
      const a = { "@type": "Product", name: "A" };
      const b = { "@type": "Product", name: "B" };
      expect(
        ldBlocks([[{ "script:ld+json": a }], [{ "script:ld+json": b }]]),
      ).toEqual([a, b]);
    });
  });
});
