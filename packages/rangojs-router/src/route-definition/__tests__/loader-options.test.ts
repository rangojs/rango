/**
 * loader() delivery options: loader(Def, { stream: "navigation" }, use?).
 *
 * The 2-arg loader(Def, use) form and the 3-arg options form share one
 * options-or-use disambiguation (typeof check, like path()'s configOrUse).
 * awaitBeforeFlush is stamped at DSL-evaluation time from ctx.isSSR — entries
 * are cached per-isSSR (router/manifest.ts), so the flag must appear only on
 * SSR-evaluated entries and never on navigation-lane ones.
 */
import { describe, it, expect, vi } from "vitest";
import { RangoContext, type EntryData } from "../../server/context.js";
import { loader } from "../dsl-helpers.js";
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
      loader(testLoaderDef(), { stream: "navigation" }, use);
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

  it("throws on an invalid stream value (JS consumers)", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, true, () => {
        loader(testLoaderDef(), { stream: "always" } as never);
      }),
    ).toThrow(/stream must be "navigation"/);
  });
});

describe("awaitBeforeFlush stamping (per-isSSR)", () => {
  it("stamps awaitBeforeFlush on an SSR evaluation", () => {
    const parent = parentEntry();
    withDslStore(parent, true, () => {
      loader(testLoaderDef(), { stream: "navigation" });
    });
    expect(parent.loader[0]!.awaitBeforeFlush).toBe(true);
  });

  it("does NOT stamp on a non-SSR (navigation-lane) evaluation", () => {
    const parent = parentEntry();
    withDslStore(parent, false, () => {
      loader(testLoaderDef(), { stream: "navigation" });
    });
    expect(parent.loader[0]!.awaitBeforeFlush).toBeUndefined();
  });

  it("does NOT stamp when isSSR is absent from the DSL context", () => {
    const parent = parentEntry();
    withDslStore(parent, undefined, () => {
      loader(testLoaderDef(), { stream: "navigation" });
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
