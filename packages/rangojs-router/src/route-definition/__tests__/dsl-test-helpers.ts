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

/**
 * Run `fn` inside a fresh DSL build context with the given parent.
 * `store` adds fields the caller needs to observe or scope (a manifest to read,
 * the router id a segment's scope is keyed by).
 */
export function withDslStore<T>(
  parent: EntryData,
  fn: () => T,
  store?: Record<string, unknown>,
): T {
  return RangoContext.run(
    {
      manifest: new Map(),
      namespace: "test",
      parent,
      counters: {},
      patterns: new Map(),
      ...store,
    } as never,
    fn,
  );
}
