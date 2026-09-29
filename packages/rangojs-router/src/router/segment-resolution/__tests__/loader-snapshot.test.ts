import { describe, it, expect, vi } from "vitest";
import {
  createElement,
  isValidElement,
  Suspense,
  type ReactElement,
} from "react";
import { renderToString } from "react-dom/server";
import type { MaskReport } from "../mask-nested.js";
import {
  elideLoaderContainer,
  maskNestedContainerThenables,
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

// maskNestedContainerThenables: the capture-side half of "nested-promise shape
// is the liveness declaration". Applied to the container the capture render and
// record consume, so a nested promise holes regardless of settle timing —
// previously a promise that settled before the quiet window baked its value
// into the shared shell and the snapshot pinned it for every visitor
// (per-request basket data served cross-session, found live).
describe("maskNestedContainerThenables", () => {
  it("replaces nested thenables (settled AND pending) with never-resolving masks", async () => {
    const settled = Promise.resolve("per-request-value");
    const pending = never();
    const out = maskNestedContainerThenables({
      label: "shared",
      fast: settled,
      slow: pending,
    }) as Record<string, unknown>;
    expect(out.label).toBe("shared");
    expect(typeof (out.fast as Promise<unknown>).then).toBe("function");
    expect(out.fast).not.toBe(settled);
    expect(out.slow).not.toBe(pending);
    // The masks never settle: elide must record holes for them.
    const elided = await elideLoaderContainer(out);
    expect(elided.state).toBe("ok");
    if (elided.state !== "ok") return;
    const v = elided.value as Record<string, unknown>;
    expect(v.label).toBe("shared");
    expect(isLoaderHoleMarker(v.fast)).toBe(true);
    expect(isLoaderHoleMarker(v.slow)).toBe(true);
  });

  it("does not mutate the input container (handler consumption keeps real values)", () => {
    const fast = Promise.resolve("real");
    const input = { label: "shared", nested: { fast }, list: [fast] };
    const out = maskNestedContainerThenables(input) as typeof input;
    expect(input.nested.fast).toBe(fast);
    expect(input.list[0]).toBe(fast);
    expect(out.nested.fast).not.toBe(fast);
    expect(out.list[0]).not.toBe(fast);
  });

  it("traverses arrays and plain objects only; other values are leaves", () => {
    const date = new Date(0);
    const map = new Map([["k", Promise.resolve(1)]]);
    const out = maskNestedContainerThenables({
      date,
      map,
      arr: [1, "x", null],
    }) as Record<string, unknown>;
    expect(out.date).toBe(date);
    expect(out.map).toBe(map);
    expect(out.arr).toEqual([1, "x", null]);
  });

  it("preserves cycles as cycles in the copy", () => {
    const input: Record<string, unknown> = { label: "a" };
    input.self = input;
    const out = maskNestedContainerThenables(input) as Record<string, unknown>;
    expect(out.self).toBe(out);
    expect(out).not.toBe(input);
  });
});

// Issue #942: the walks copied React elements key by key, dropping the
// non-enumerable dev fields (_debugStack, _debugTask, ref), so dev Flight
// refused the copy and the capture crashed. Real Flight in both React builds:
// loader-container-jsx(-dev).rsc-test.ts.
describe("React elements in a loader container (#942)", () => {
  type AnyElement = ReactElement<Record<string, unknown>> & {
    _owner?: unknown;
    _debugStack?: unknown;
    _debugTask?: unknown;
    _store?: { validated: number };
  };

  /** The shape React's production ReactElement returns. */
  function productionElement(
    type: unknown,
    props: Record<string, unknown>,
  ): AnyElement {
    return {
      $$typeof: Symbol.for("react.transitional.element"),
      type,
      key: null,
      ref: null,
      props,
    } as unknown as AnyElement;
  }

  function developmentElement(
    type: unknown,
    props: Record<string, unknown>,
  ): AnyElement {
    return createElement(type as string, props) as unknown as AnyElement;
  }

  function Card(_props: Record<string, unknown>): null {
    return null;
  }

  /** A server component: Flight calls it during the pin encode. */
  function ServerReviews(_props: Record<string, unknown>): null {
    return null;
  }

  /** The shape a "use client" export has in the RSC environment. */
  const ClientReviews = Object.assign(
    function ClientReviews(): null {
      throw new Error("client reference called on the server");
    },
    { $$typeof: Symbol.for("react.client.reference") },
  );

  describe.each([
    ["development", developmentElement],
    ["production", productionElement],
  ])("%s element shape", (_label, element) => {
    it("the mask returns an element without thenables by identity", () => {
      const heading = element("h2", { children: "Related" });
      const input = { related: heading, list: [heading] };
      const report: MaskReport = { thenable: false };
      const out = maskNestedContainerThenables(
        input,
        undefined,
        report,
      ) as typeof input;
      expect(out.related).toBe(heading);
      expect(out.list[0]).toBe(heading);
      expect(report.thenable).toBe(false);
    });

    it("elide pins an element without thenables whole", async () => {
      const heading = element("h2", { children: "Related" });
      const r = await elideLoaderContainer({ related: heading });
      expect(r.state).toBe("ok");
      if (r.state !== "ok") return;
      expect(r.hasHole).toBe(false);
      expect((r.value as Record<string, unknown>).related).toBe(heading);
    });

    it("elide keeps the hole inside a host element's props and pins the rest", async () => {
      const heading = element("h2", { children: "Reviews" });
      const reviews = element("section", {
        className: "reviews",
        children: [heading, element("p", { children: never() })],
      });
      const r = await elideLoaderContainer({ product: "p1", reviews });
      expect(r.state).toBe("ok");
      if (r.state !== "ok") return;
      expect(r.hasHole).toBe(true);
      const recorded = (r.value as { reviews: AnyElement }).reviews;
      expect(isValidElement(recorded)).toBe(true);
      expect(recorded.type).toBe("section");
      expect(recorded.props.className).toBe("reviews");
      const [h2, p] = recorded.props.children as AnyElement[];
      expect(h2).toBe(heading);
      expect(p!.type).toBe("p");
      expect(isLoaderHoleMarker(p!.props.children)).toBe(true);
    });

    it("elide keeps the hole inside a client component's props and pins the rest", async () => {
      const r = await elideLoaderContainer({
        reviews: element(ClientReviews, { heading: "Reviews", data: never() }),
      });
      expect(r.state).toBe("ok");
      if (r.state !== "ok") return;
      expect(r.hasHole).toBe(true);
      const recorded = (r.value as { reviews: AnyElement }).reviews;
      expect(recorded.type).toBe(ClientReviews);
      expect(recorded.props.heading).toBe("Reviews");
      expect(isLoaderHoleMarker(recorded.props.data)).toBe(true);
    });

    it.each([
      ["a function component", ServerReviews],
      ["memo()", { $$typeof: Symbol.for("react.memo"), type: ServerReviews }],
      [
        "forwardRef()",
        { $$typeof: Symbol.for("react.forward_ref"), render: ServerReviews },
      ],
      [
        "lazy()",
        {
          $$typeof: Symbol.for("react.lazy"),
          _payload: null,
          _init: () => ServerReviews,
        },
      ],
    ])(
      "elide records a server component (%s) whose props hold a thenable as one hole",
      async (_kind, type) => {
        const r = await elideLoaderContainer({
          section: element("section", {
            children: [element(type, { data: never() })],
          }),
        });
        expect(r.state).toBe("ok");
        if (r.state !== "ok") return;
        expect(r.hasHole).toBe(true);
        const section = (r.value as { section: AnyElement }).section;
        expect(section.type).toBe("section");
        expect(
          isLoaderHoleMarker((section.props.children as unknown[])[0]),
        ).toBe(true);
      },
    );

    it.each([
      [
        "a lazy() resolving to a client component",
        {
          $$typeof: Symbol.for("react.lazy"),
          _payload: null,
          _init: () => ClientReviews,
        },
      ],
      [
        "a Flight-decoded client type (lazy around a client reference)",
        {
          $$typeof: Symbol.for("react.lazy"),
          _payload: { value: ClientReviews },
          _init: (chunk: { value: unknown }) => chunk.value,
        },
      ],
    ])("elide keeps the hole inside the props of %s", async (_kind, type) => {
      const r = await elideLoaderContainer({
        reviews: element(type, { heading: "Reviews", data: never() }),
      });
      expect(r.state).toBe("ok");
      if (r.state !== "ok") return;
      const recorded = (r.value as { reviews: AnyElement }).reviews;
      expect(isValidElement(recorded)).toBe(true);
      expect(recorded.props.heading).toBe("Reviews");
      expect(isLoaderHoleMarker(recorded.props.data)).toBe(true);
    });

    it("elide records a lazy() that cannot resolve yet as one hole", async () => {
      const pending = {
        $$typeof: Symbol.for("react.lazy"),
        _payload: null,
        _init: () => {
          throw new Promise(() => {});
        },
      };
      const r = await elideLoaderContainer({
        reviews: element(pending, { data: never() }),
      });
      expect(r.state).toBe("ok");
      if (r.state !== "ok") return;
      expect(
        isLoaderHoleMarker((r.value as { reviews: unknown }).reviews),
      ).toBe(true);
    });

    it("elide descends a memo() of a client component", async () => {
      const r = await elideLoaderContainer({
        reviews: element(
          { $$typeof: Symbol.for("react.memo"), type: ClientReviews },
          { data: never() },
        ),
      });
      expect(r.state).toBe("ok");
      if (r.state !== "ok") return;
      const recorded = (r.value as { reviews: AnyElement }).reviews;
      expect(isValidElement(recorded)).toBe(true);
      expect(isLoaderHoleMarker(recorded.props.data)).toBe(true);
    });

    it("the overlay fills a hole inside a recorded element; its other props come from the pin", () => {
      const pinnedHeading = element("h2", { children: "pinned" });
      const recorded = {
        reviews: element("section", {
          className: "pinned",
          children: [
            pinnedHeading,
            element("p", { children: { [LOADER_HOLE_KEY]: 1 } }),
          ],
        }),
      };
      const livePromise = never();
      const fresh = {
        reviews: element("section", {
          className: "fresh",
          children: [
            element("h2", { children: "fresh" }),
            element("p", { children: livePromise }),
          ],
        }),
      };
      const out = overlayLoaderContainer(fresh, recorded) as {
        reviews: AnyElement;
      };
      expect(isValidElement(out.reviews)).toBe(true);
      expect(out.reviews).not.toBe(recorded.reviews);
      expect(out.reviews.type).toBe("section");
      expect(out.reviews.props.className).toBe("pinned");
      const [h2, p] = out.reviews.props.children as AnyElement[];
      expect(h2).toBe(pinnedHeading);
      expect(p!.type).toBe("p");
      expect(p!.props.children).toBe(livePromise);
    });

    it("the overlay keeps a recorded element without holes by identity and fills an element-sized hole with the fresh element", () => {
      const pinned = element("h2", { children: "pinned" });
      const freshReviews = element(ServerReviews, { data: never() });
      const fresh = {
        related: element("h2", { children: "fresh" }),
        reviews: freshReviews,
      };
      const recorded = { related: pinned, reviews: { [LOADER_HOLE_KEY]: 1 } };
      const out = overlayLoaderContainer(fresh, recorded) as typeof fresh;
      expect(out.related).toBe(pinned);
      expect(out.reviews).toBe(freshReviews);
      // Hole-free pin-first path.
      const pinFirst = overlayLoaderContainer(undefined, {
        related: pinned,
      }) as { related: unknown };
      expect(pinFirst.related).toBe(pinned);
    });

    it("the overlay does not read a fresh element as a plain object", () => {
      const out = overlayLoaderContainer(element("p", { children: "fresh" }), {
        title: "pinned",
      });
      expect(out).toEqual({ title: "pinned" });
    });
  });

  it("the mask clones an element whose props hold a thenable through cloneElement, keeping its dev fields and key validation", () => {
    const perRequest = Promise.resolve("per-request");
    const heading = createElement("h2", null, "Reviews");
    const body = createElement("p", null, perRequest as never);
    // Children passed as arguments are key-validated at creation.
    const reviews = createElement(
      "section",
      { key: "reviews", className: "reviews" },
      heading,
      body,
    ) as unknown as AnyElement;
    const report: MaskReport = { thenable: false };
    const out = maskNestedContainerThenables(
      { reviews },
      undefined,
      report,
    ) as { reviews: AnyElement };
    expect(report.thenable).toBe(true);

    const cloned = out.reviews;
    expect(isValidElement(cloned)).toBe(true);
    expect(cloned).not.toBe(reviews);
    expect(cloned.type).toBe("section");
    expect(cloned.key).toBe("reviews");
    expect(cloned.props.className).toBe("reviews");
    expect(cloned._owner).toBe(reviews._owner);
    expect(cloned._debugStack).toBeDefined();
    expect(cloned._debugStack).toBe(reviews._debugStack);
    expect(cloned._debugTask).toBe(reviews._debugTask);

    const [clonedHeading, clonedBody] = cloned.props.children as AnyElement[];
    // A sibling without thenables keeps its identity.
    expect(clonedHeading).toBe(heading);
    expect(clonedBody).not.toBe(body);
    const original = body as unknown as AnyElement;
    expect(clonedBody._debugStack).toBe(original._debugStack);
    // cloneElement resets it; the keyless child would then warn in a list.
    expect(original._store?.validated).toBe(1);
    expect(clonedBody._store?.validated).toBe(1);
    const masked = clonedBody.props.children;
    expect(masked).not.toBe(perRequest);
    expect(typeof (masked as PromiseLike<unknown>).then).toBe("function");
    // The input is never mutated.
    expect(original.props.children).toBe(perRequest);
  });

  it("a masked child of a static children list renders without a missing-key warning", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const section = createElement(
        "section",
        null,
        createElement("h2", null, "Reviews"),
        createElement(
          Suspense,
          { fallback: "loading" },
          createElement("p", null, Promise.resolve("live") as never),
        ),
      );
      renderToString(section);
      expect(errors).not.toHaveBeenCalled();
      const masked = maskNestedContainerThenables(section) as typeof section;
      expect(masked).not.toBe(section);
      renderToString(masked);
      const keyWarnings = errors.mock.calls.filter((args) =>
        String(args[0]).includes('unique "key"'),
      );
      expect(keyWarnings).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("the overlay rebuilds an element through cloneElement, keeping its dev fields and key validation", () => {
    const live = never();
    const pinnedBody = createElement("p", null, {
      [LOADER_HOLE_KEY]: 1,
    } as never) as unknown as AnyElement;
    const recorded = createElement(
      "section",
      null,
      createElement("h2", null, "Reviews"),
      pinnedBody as never,
    );
    const fresh = createElement(
      "section",
      null,
      createElement("h2", null, "Reviews"),
      createElement("p", null, live as never),
    );
    const out = overlayLoaderContainer(fresh, recorded) as AnyElement;
    const body = (out.props.children as AnyElement[])[1]!;
    expect(body.props.children).toBe(live);
    expect(body._debugStack).toBe(pinnedBody._debugStack);
    expect(pinnedBody._store?.validated).toBe(1);
    expect(body._store?.validated).toBe(1);
  });

  it("the overlay sees through a resolved lazy node to fill a hole; an unresolved one stays a leaf", () => {
    const live = never();
    const lazyNode = {
      $$typeof: Symbol.for("react.lazy"),
      _payload: createElement("p", null, { [LOADER_HOLE_KEY]: 1 } as never),
      _init: (payload: unknown) => payload,
    };
    const out = overlayLoaderContainer(
      { reviews: createElement("p", null, live as never) },
      { reviews: lazyNode },
    ) as { reviews: AnyElement };
    expect(isValidElement(out.reviews)).toBe(true);
    expect(out.reviews.props.children).toBe(live);

    const pending = {
      $$typeof: Symbol.for("react.lazy"),
      _payload: null,
      _init: () => {
        throw new Promise(() => {});
      },
    };
    const kept = overlayLoaderContainer(undefined, { reviews: pending }) as {
      reviews: unknown;
    };
    expect(kept.reviews).toBe(pending);
  });

  it("the overlay reads a fresh lazy node only when a recorded path needs the fresh value", () => {
    const live = never();
    const freshInit = vi.fn(() =>
      createElement("section", null, createElement("p", null, live as never)),
    );
    const freshLazy = {
      $$typeof: Symbol.for("react.lazy"),
      _payload: null,
      _init: freshInit,
    };

    const pinned = createElement("section", null, "pinned");
    expect(overlayLoaderContainer(freshLazy, pinned)).toBe(pinned);
    expect(freshInit).not.toHaveBeenCalled();

    const withHole = createElement(
      "section",
      null,
      createElement("p", null, { [LOADER_HOLE_KEY]: 1 } as never),
    );
    const out = overlayLoaderContainer(freshLazy, withHole) as AnyElement;
    expect(freshInit).toHaveBeenCalledTimes(1);
    expect((out.props.children as AnyElement).props.children).toBe(live);
  });

  it("the mask masks a shared subtree inside an element when the subtree was walked first", () => {
    const shared = { price: Promise.resolve(42) };
    const input = { summary: shared, card: createElement(Card, { shared }) };
    const out = maskNestedContainerThenables(input) as {
      summary: typeof shared;
      card: AnyElement;
    };
    expect(out.summary).not.toBe(shared);
    expect(out.summary.price).not.toBe(shared.price);
    expect(out.card).not.toBe(input.card);
    expect(out.card.props.shared).toBe(out.summary);
  });

  it("the mask treats a lazy node as a leaf", () => {
    const lazy = {
      $$typeof: Symbol.for("react.lazy"),
      _payload: Promise.resolve("chunk"),
      _init: (payload: unknown) => payload,
    };
    const report: MaskReport = { thenable: false };
    const out = maskNestedContainerThenables({ lazy }, undefined, report) as {
      lazy: unknown;
    };
    expect(out.lazy).toBe(lazy);
    expect(report.thenable).toBe(false);
  });

  it("elide records a hole on every path to a shared subtree", async () => {
    // The mask keeps shared subtrees shared. Pinning the second path raw left
    // a never-settling masked promise in the record for the pin encode.
    const shared = { price: never() };
    const r = await elideLoaderContainer({ a: shared, b: shared });
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    const v = r.value as { a: typeof shared; b: typeof shared };
    expect(isLoaderHoleMarker(v.a.price)).toBe(true);
    expect(isLoaderHoleMarker(v.b.price)).toBe(true);
    expect(r.hasHole).toBe(true);
  });
});
