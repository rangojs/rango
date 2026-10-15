import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { urls } from "../../urls.js";
import { createLoader } from "../../loader.js";
import type { RouteEntry } from "../../types.js";
import type {
  EntryData,
  LoaderEntry,
  ParallelEntryData,
} from "../../server/context.js";
import { getDocumentModeEntry, RangoContext } from "../../server/context.js";
import { findLazyIncludes } from "../lazy-includes.js";
import { loadManifest, clearManifestCache } from "../manifest.js";
import type { AllUseItems } from "../../route-types.js";
import { makeSyntheticRoot } from "../../__tests__/helpers/synthetic-root.js";

// Issue #1179: include() captures its parent chain on an evaluation without
// isSSR (router.ts routes(), lazy-includes.ts runExpansion), and loadManifest
// reuses it for every request. A document request must see the captured
// ancestors as a document (isSSR) evaluation builds them.

const Div = createElement("div");
const Fallback = createElement("p", null, "fallback");

const RootLoader = (createLoader as Function)(
  async () => ({}),
  undefined,
  "test#RootLoader",
);
const StoreLoader = (createLoader as Function)(
  async () => ({}),
  undefined,
  "test#StoreLoader",
);
const LiveLoader = (createLoader as Function)(
  async () => ({}),
  undefined,
  "test#LiveLoader",
);
const SlotLoader = (createLoader as Function)(
  async () => ({}),
  undefined,
  "test#SlotLoader",
);
const OrphanLoader = (createLoader as Function)(
  async () => ({}),
  undefined,
  "test#OrphanLoader",
);

const sectionPatterns = urls<any>(({ path }) => [
  path("/page", Div, { name: "page" }),
]);

const rootPatterns = urls<any>(
  ({ layout, loader, loading, parallel, path, include }) => [
    layout(Div, () => [
      loader(RootLoader, { ssr: false }),
      loading(Fallback, { ssr: false }),
      layout(Div, () => [
        loader(StoreLoader, { ssr: false }),
        loader(LiveLoader),
        loading(Fallback, { ssr: false }),
        parallel({ "@aside": Div }, () => [
          loader(SlotLoader, { ssr: false }),
          loading(Fallback, { ssr: false }),
        ]),
        layout(Div, () => [
          loader(OrphanLoader, { ssr: false }),
          loading(Fallback, { ssr: false }),
        ]),
        path("/direct", Div, { name: "direct" }),
        include("/section", sectionPatterns, { name: "section" }),
      ]),
    ]),
  ],
);

/** The include entry router.ts routes() registers: no isSSR in the context. */
function registerInclude(): RouteEntry {
  let items: AllUseItems[] = [];
  RangoContext.run(
    {
      manifest: new Map(),
      patterns: new Map(),
      patternsByPrefix: new Map(),
      trailingSlash: new Map(),
      namespace: "root",
      parent: makeSyntheticRoot(),
      counters: {},
      mountIndex: 0,
    },
    () => {
      items = rootPatterns.handler() as AllUseItems[];
    },
  );
  const [include] = findLazyIncludes(items);
  return {
    prefix: "",
    staticPrefix: "/section",
    routes: { "section.page": "/section/page" } as any,
    handler: rootPatterns.handler,
    mountIndex: 1,
    lazy: true,
    lazyEvaluated: false,
    lazyPatterns: include!.patterns,
    lazyContext: include!.context,
    _lazyPrefix: "/section",
  } as unknown as RouteEntry;
}

const directEntry = {
  prefix: "",
  staticPrefix: "",
  routes: { direct: "/direct" } as any,
  handler: rootPatterns.handler,
  mountIndex: 0,
} as unknown as RouteEntry;

function load(
  entry: RouteEntry,
  routeKey: string,
  isSSR: boolean,
): Promise<EntryData> {
  return RangoContext.run(
    {
      manifest: new Map(),
      patterns: new Map(),
      patternsByPrefix: new Map(),
      trailingSlash: new Map(),
      namespace: "root",
      parent: null,
      counters: {},
    },
    () => loadManifest(entry, routeKey, `/${routeKey}`, undefined, isSSR),
  );
}

type LoaderFlags = { id: string; awaitBeforeFlush?: true; bake?: true };

function loaderFlags(loaders: LoaderEntry[]): LoaderFlags[] {
  return loaders.map((l) => ({
    id: l.loader.$$id,
    ...(l.awaitBeforeFlush && { awaitBeforeFlush: l.awaitBeforeFlush }),
    ...(l.bake && { bake: l.bake }),
  }));
}

/** What a document reads off each ancestor: its own, its slots', its orphans'. */
function documentShape(route: EntryData) {
  const shape = [];
  for (let entry = route.parent; entry; entry = entry.parent) {
    shape.push({
      shortCode: entry.shortCode,
      loaders: loaderFlags(entry.loader),
      loading: entry.loading,
      slots: Object.values(entry.parallel).map((slot) => ({
        loaders: loaderFlags((slot as ParallelEntryData).loader),
        loading: (slot as ParallelEntryData).loading,
      })),
      orphans: entry.layout.map((orphan) => ({
        loaders: loaderFlags(orphan.loader),
        loading: orphan.loading,
      })),
    });
  }
  return shape;
}

/** The ancestors above the route's include-owned entries. */
function capturedShape(route: EntryData) {
  return documentShape(route).filter((a) => a.loaders.length > 0);
}

beforeEach(() => {
  clearManifestCache();
});

describe("loadManifest: a lazy include's captured ancestors on a document request (#1179)", () => {
  it("carry the document decisions an isSSR evaluation makes, like a route declared beside the include", async () => {
    const included = await load(registerInclude(), "section.page", true);
    const direct = await load(directEntry, "direct", true);

    const shape = capturedShape(included);
    expect(shape).toEqual(capturedShape(direct));
    // The store layout: its slot and its orphan, then the root layout.
    expect(shape).toHaveLength(2);
    const [store, root] = shape;
    expect(store!.loaders).toEqual([
      { id: "test#StoreLoader", awaitBeforeFlush: true, bake: true },
      { id: "test#LiveLoader" },
    ]);
    expect(store!.loading).toBe(false);
    expect(store!.slots).toEqual([
      {
        loaders: [
          { id: "test#SlotLoader", awaitBeforeFlush: true, bake: true },
        ],
        loading: false,
      },
    ]);
    expect(store!.orphans).toEqual([
      {
        loaders: [
          { id: "test#OrphanLoader", awaitBeforeFlush: true, bake: true },
        ],
        loading: false,
      },
    ]);
    expect(root!.loaders).toEqual([
      { id: "test#RootLoader", awaitBeforeFlush: true, bake: true },
    ]);
    expect(root!.loading).toBe(false);
  });

  it("are left as captured for a navigation, like a route declared beside the include", async () => {
    const included = await load(registerInclude(), "section.page", false);
    const direct = await load(directEntry, "direct", false);

    const shape = capturedShape(included);
    expect(shape).toEqual(capturedShape(direct));
    const [store] = shape;
    expect(store!.loaders).toEqual([
      { id: "test#StoreLoader", bake: true },
      { id: "test#LiveLoader" },
    ]);
    expect(store!.loading).toBe(Fallback);
  });

  it("do not change the captured chain a navigation reuses", async () => {
    const entry = registerInclude();
    const captured = entry.lazyContext!.parent as EntryData;

    await load(entry, "section.page", true);

    expect(loaderFlags(captured.loader)).toEqual([
      { id: "test#StoreLoader", bake: true },
      { id: "test#LiveLoader" },
    ]);
    expect(captured.loading).toBe(Fallback);
    const navigation = await load(entry, "section.page", false);
    expect(capturedShape(navigation)[0]!.loading).toBe(Fallback);
  });
});

describe("getDocumentModeEntry", () => {
  it("maps an ancestor several entries share to one copy, and a copy to itself", () => {
    const shared = makeSyntheticRoot();
    const child = { ...makeSyntheticRoot(), id: "child", parent: shared };
    const sibling = { ...makeSyntheticRoot(), id: "sibling", parent: shared };

    const copy = getDocumentModeEntry(child);

    expect(copy).not.toBe(child);
    expect(copy.parent).toBe(getDocumentModeEntry(sibling).parent);
    expect(copy.parent).not.toBe(shared);
    expect(getDocumentModeEntry(copy)).toBe(copy);
  });
});
