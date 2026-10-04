import { RangoContext, type EntryData } from "../../server/context.js";

/** A parent entry shaped enough for DSL helpers to attach to. */
export function parentEntry(): EntryData {
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
export function withDslStore<T>(parent: EntryData, fn: () => T): T {
  return RangoContext.run(
    {
      manifest: new Map(),
      namespace: "test",
      parent,
      counters: {},
      patterns: new Map(),
    } as never,
    fn,
  );
}
