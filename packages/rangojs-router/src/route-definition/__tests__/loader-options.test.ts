/**
 * loader() delivery options: loader(Def, { ssr: false }, use?).
 *
 * The 2-arg loader(Def, use) form and the 3-arg options form share one
 * options-or-use disambiguation (typeof check, like path()'s configOrUse).
 * awaitBeforeFlush is stamped at DSL-evaluation time from ctx.isSSR — entries
 * are cached per-isSSR (router/manifest.ts), so the flag must appear only on
 * SSR-evaluated entries and never on navigation-lane ones.
 */
import { describe, it, expect, vi } from "vitest";
import { RangoContext, type EntryData } from "../../server/context.js";
import { loader, loading } from "../dsl-helpers.js";
import type { LoaderDefinition } from "../../types.js";

/** A parent entry shaped enough for loader() to attach to. */
function parentEntry(): EntryData {
  return {
    id: "test",
    shortCode: "L0",
    type: "layout",
    parent: null,
    handler: null,
    loading: undefined,
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: {},
    intercept: [],
    loader: [],
  } as unknown as EntryData;
}

/** Run `fn` inside a fresh DSL build context with the given parent. */
function withDslStore<T>(
  parent: EntryData,
  isSSR: boolean | undefined,
  fn: () => T,
): T {
  return RangoContext.run(
    {
      manifest: new Map(),
      namespace: "test",
      parent,
      counters: {},
      patterns: new Map(),
      ...(isSSR !== undefined && { isSSR }),
    } as never,
    fn,
  );
}

function testLoaderDef(): LoaderDefinition<any> {
  return {
    __brand: "loader",
    $$id: "test#Loader",
    fn: async () => "data",
  } as unknown as LoaderDefinition<any>;
}

describe("loader() options disambiguation", () => {
  it("2-arg form loader(Def, use) still runs the use() callback", () => {
    const parent = parentEntry();
    const use = vi.fn(() => []);
    withDslStore(parent, true, () => {
      loader(testLoaderDef(), use);
    });
    expect(use).toHaveBeenCalledTimes(1);
    expect(parent.loader).toHaveLength(1);
    expect(parent.loader[0]!.awaitBeforeFlush).toBeUndefined();
  });

  it("3-arg form loader(Def, options, use) runs the use() callback", () => {
    const parent = parentEntry();
    const use = vi.fn(() => []);
    withDslStore(parent, true, () => {
      loader(testLoaderDef(), { ssr: false }, use);
    });
    expect(use).toHaveBeenCalledTimes(1);
    expect(parent.loader).toHaveLength(1);
  });

  it("throws when two use() callbacks are passed", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, true, () => {
        loader(testLoaderDef(), (() => []) as never, () => []);
      }),
    ).toThrow(/two use\(\) callbacks/);
  });

  it("throws on an invalid ssr value (JS consumers)", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, true, () => {
        loader(testLoaderDef(), { ssr: "never" } as never);
      }),
    ).toThrow(/ssr must be a boolean/);
  });

  it("rejects the removed stream option with a pointer to ssr: false", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, true, () => {
        loader(testLoaderDef(), { stream: "navigation" } as never);
      }),
    ).toThrow(/stream was replaced.*ssr: false/);
  });
});

describe("awaitBeforeFlush stamping (per-isSSR)", () => {
  it("stamps awaitBeforeFlush on an SSR evaluation", () => {
    const parent = parentEntry();
    withDslStore(parent, true, () => {
      loader(testLoaderDef(), { ssr: false });
    });
    expect(parent.loader[0]!.awaitBeforeFlush).toBe(true);
  });

  it("ssr: true is the explicit default — no stamp", () => {
    const parent = parentEntry();
    withDslStore(parent, true, () => {
      loader(testLoaderDef(), { ssr: true });
    });
    expect(parent.loader[0]!.awaitBeforeFlush).toBeUndefined();
  });

  it("does NOT stamp on a non-SSR (navigation-lane) evaluation", () => {
    const parent = parentEntry();
    withDslStore(parent, false, () => {
      loader(testLoaderDef(), { ssr: false });
    });
    expect(parent.loader[0]!.awaitBeforeFlush).toBeUndefined();
  });

  it("does NOT stamp when isSSR is absent from the DSL context", () => {
    const parent = parentEntry();
    withDslStore(parent, undefined, () => {
      loader(testLoaderDef(), { ssr: false });
    });
    expect(parent.loader[0]!.awaitBeforeFlush).toBeUndefined();
  });

  it("an empty options object is inert", () => {
    const parent = parentEntry();
    withDslStore(parent, true, () => {
      loader(testLoaderDef(), {});
    });
    expect(parent.loader[0]!.awaitBeforeFlush).toBeUndefined();
  });
});

// The PPR bake lane rides on `bake`, which a navigation evaluation carries
// too: its shell replay pins the loaders a document HIT pins.
describe("bake stamping (every evaluation)", () => {
  it.each([
    ["an SSR", true],
    ["a navigation-lane", false],
    ["an isSSR-less", undefined],
  ] as const)(
    "stamps bake for ssr: false on %s evaluation",
    (_label, isSSR) => {
      const parent = parentEntry();
      withDslStore(parent, isSSR, () => {
        loader(testLoaderDef(), { ssr: false });
      });
      expect(parent.loader[0]!.bake).toBe(true);
    },
  );

  it("does not stamp bake without ssr: false", () => {
    const parent = parentEntry();
    withDslStore(parent, true, () => {
      loader(testLoaderDef(), { ssr: true });
      loader(testLoaderDef());
    });
    expect(parent.loader.map((entry) => entry.bake)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

// prefetch: false (docs/design/prefetch-false.md). The flag is a property of
// the registration, the same on every evaluation: a prefetch is served from
// the navigation-lane entries, the rendered() guard reads the document ones.
describe("loader() prefetch option", () => {
  it.each([
    ["an SSR", true],
    ["a navigation-lane", false],
    ["an isSSR-less", undefined],
  ] as const)("records prefetch: false on %s evaluation", (_label, isSSR) => {
    const parent = parentEntry();
    withDslStore(parent, isSSR, () => {
      loader(testLoaderDef(), { prefetch: false });
    });
    expect(parent.loader[0]!.prefetch).toBe(false);
  });

  it("records nothing for prefetch: true, an empty options object or no options", () => {
    const parent = parentEntry();
    withDslStore(parent, false, () => {
      loader(testLoaderDef(), { prefetch: true });
      loader(testLoaderDef(), {});
      loader(testLoaderDef());
    });
    expect(parent.loader.map((entry) => "prefetch" in entry)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("combines with ssr: false and still runs the use() callback", () => {
    const parent = parentEntry();
    const use = vi.fn(() => []);
    withDslStore(parent, true, () => {
      loader(testLoaderDef(), { ssr: false, prefetch: false }, use);
    });
    expect(use).toHaveBeenCalledTimes(1);
    expect(parent.loader[0]).toMatchObject({
      prefetch: false,
      bake: true,
      awaitBeforeFlush: true,
    });
  });

  it("throws on a prefetch value that is not a boolean (JS consumers)", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, true, () => {
        loader(testLoaderDef(), { prefetch: "never" } as never);
      }),
    ).toThrow(/loader\(\) prefetch must be a boolean \(got "never"\)/);
  });
});

describe("loading() prefetch option", () => {
  const fallback = "skeleton";

  it.each([
    ["an SSR", true],
    ["a navigation-lane", false],
  ] as const)("records the flag on %s evaluation", (_label, isSSR) => {
    const parent = parentEntry();
    withDslStore(parent, isSSR, () => {
      loading(fallback, { prefetch: false });
    });
    expect(parent.loadingPrefetch).toBe(false);
    expect(parent.loading).toBe(fallback);
  });

  it("records it with ssr: false too, where the document shows no fallback", () => {
    const parent = parentEntry();
    withDslStore(parent, true, () => {
      loading(fallback, { ssr: false, prefetch: false });
    });
    // The document evaluation suppresses the fallback and still knows the
    // entry is flagged: the rendered() guard reads these entries.
    expect(parent.loading).toBe(false);
    expect(parent.loadingPrefetch).toBe(false);
  });

  it("unwraps the function form before deciding", () => {
    const parent = parentEntry();
    withDslStore(parent, false, () => {
      loading(() => fallback, { prefetch: false });
    });
    expect(parent.loadingPrefetch).toBe(false);
  });

  it.each([[null], [false], [undefined]])(
    "records nothing without a fallback to show (%s)",
    (component) => {
      const parent = parentEntry();
      withDslStore(parent, false, () => {
        loading(component as never, { prefetch: false });
      });
      expect(parent.loadingPrefetch).toBeUndefined();
    },
  );

  it("records nothing for prefetch: true or no options", () => {
    const parent = parentEntry();
    withDslStore(parent, false, () => {
      loading(fallback, { prefetch: true });
    });
    expect(parent.loadingPrefetch).toBeUndefined();
    withDslStore(parent, false, () => {
      loading(fallback);
    });
    expect(parent.loadingPrefetch).toBeUndefined();
  });

  it("the last loading() on an entry decides, like the fallback itself", () => {
    const parent = parentEntry();
    withDslStore(parent, false, () => {
      loading(fallback, { prefetch: false });
      loading("other");
    });
    expect(parent.loading).toBe("other");
    expect(parent.loadingPrefetch).toBeUndefined();
  });

  it("throws on a prefetch value that is not a boolean (JS consumers)", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, false, () => {
        loading(fallback, { prefetch: 0 } as never);
      }),
    ).toThrow(/loading\(\) prefetch must be a boolean \(got 0\)/);
  });
});
