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

  // G4: re-pushing an existing href (e.g. a child refreshing a parent crumb's
  // label) must NOT reorder the crumb to the end — parent->child order is the
  // documented contract. The href keeps its FIRST position but the LAST value.
  it("re-pushing an existing crumb keeps parent->child order (dedup in place)", () => {
    const homeCurrent = { label: "Home (current)", href: "/" };
    // Home pushed first, Blog second, then Home re-pushed in a deeper segment.
    const result = collectHandle(Breadcrumbs, [[home], [blog], [homeCurrent]]);
    // Home stays in position 0 (with the refreshed label), Blog stays after it.
    expect(result).toEqual([homeCurrent, blog]);
    expect(result.map((c) => c.href)).toEqual(["/", "/blog"]);
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

  // G3: Promise descriptors cannot be inspected synchronously (collectMeta never
  // awaits), so they are append-only: they bypass key-dedup and title-templating.
  // The collect must (a) still pass the Promise through untouched (so MetaTags can
  // resolve it via use()), and (b) warn in dev when a title template is active,
  // since a Promise<{ title }> silently misses the template and yields a 2nd <title>.
  describe("async (Promise) meta descriptors", () => {
    it("passes a Promise descriptor through untouched (append-only)", () => {
      const p = Promise.resolve({ property: "og:title", content: "Async" });
      const result = collectHandle(Meta, [
        [{ property: "og:title", content: "Sync" }],
        [p],
      ] as never) as Array<unknown>;
      // The sync og:title stays; the Promise is appended as-is, NOT deduped
      // against it (its content is unknown until it resolves).
      expect(result).toContain(p);
      expect(
        (result as Array<Record<string, unknown>>).some(
          (d) => d && typeof d === "object" && d.property === "og:title",
        ),
      ).toBe(true);
    });

    it("does NOT dedupe a Promise og: descriptor against a sync one", () => {
      const p = Promise.resolve({ property: "og:title", content: "Async" });
      const result = collectHandle(Meta, [
        [{ property: "og:title", content: "Sync" }],
        [p],
      ] as never) as Array<unknown>;
      // Both the sync descriptor and the unresolved Promise survive (2 entries).
      const ogish = result.filter(
        (d) =>
          d === p ||
          (d &&
            typeof d === "object" &&
            (d as Record<string, unknown>).property === "og:title"),
      );
      expect(ogish).toHaveLength(2);
    });

    it("warns in dev when a Promise descriptor is pushed under an active title template", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const p = Promise.resolve({ title: "Async Title" });
      const result = collectHandle(Meta, [
        [{ title: { template: "%s | Acme", default: "Acme" } }],
        [p],
      ] as never) as Array<unknown>;

      // The template default survives as a sync <title>; the Promise is appended
      // separately (bypassing the template), so the dev-warn fires.
      expect(result).toContain(p);
      expect(warn).toHaveBeenCalled();
      expect(
        warn.mock.calls.some((c) => /title template/i.test(String(c[0]))),
      ).toBe(true);
      warn.mockRestore();
    });

    it("does NOT warn for a Promise descriptor when no title template is active", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const p = Promise.resolve({ property: "og:image", content: "x.png" });
      collectHandle(Meta, [[p]] as never);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("treats a non-callable `then` as a SYNC descriptor (collect/render agree)", () => {
      // A descriptor carrying a NON-callable `then` (e.g. a serialized shape)
      // must NOT be classified as a Promise — otherwise collect appends it while
      // MetaTags' render side would call React's use() on it and throw. The
      // shared isThenable predicate (callable `then`) keeps both sides in sync:
      // here the descriptor is deduped/templated as an ordinary sync title.
      const result = collectHandle(Meta, [
        [{ then: 5, title: "Sync via non-callable then" }],
      ] as never) as Array<Record<string, unknown>>;
      const titles = result.filter((d) => "title" in d);
      expect(titles).toHaveLength(1);
      expect(titles[0]!.title).toBe("Sync via non-callable then");
    });

    // The warning is a general note, NOT a duplicate-<title> prediction.
    // collectMeta can't tell a title-Promise from an og:image-Promise
    // synchronously, so asserting a guaranteed second <title> would be a false
    // positive for the common async og:image case. The softened message must not
    // claim a duplicate <title> will occur.
    it("does NOT assert a guaranteed duplicate <title> in the warning message", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const p = Promise.resolve({ property: "og:image", content: "x.png" });
      collectHandle(Meta, [
        [{ title: { template: "%s | Acme", default: "Acme" } }],
        [p],
      ] as never);
      // It still warns (template is active, content unknowable)...
      expect(warn).toHaveBeenCalled();
      // ...but the message must not over-claim a duplicate / second <title>.
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => /duplicate <title>/i.test(m))).toBe(false);
      expect(messages.some((m) => /second <title>/i.test(m))).toBe(false);
      warn.mockRestore();
    });
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
