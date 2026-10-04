/**
 * restoreHandles and appendHandles over a record's loader-owned values: a
 * copy stands only where the record also supplies the loader's value (a
 * pin); everywhere else it is a placeholder the loader's own source replaces
 * (docs/design/handle-push-ownership.md).
 */
import { describe, it, expect } from "vitest";
import {
  appendHandles,
  captureOwnedHandles,
  restoreHandles,
  type OwnedPushDelivery,
} from "../handle-snapshot.js";
import {
  createHandleStore,
  type RecordAuthority,
} from "../../server/handle-store.js";
import {
  runInsideLoaderBodyScope,
  runInsideLoaderScope,
} from "../../server/context.js";
import type { HandleOwners, SegmentHandleData } from "../types.js";

type Store = ReturnType<typeof createHandleStore>;

/** A delivery over a fixed table, as loaderPins answers from the pins. */
function delivery(
  table: Record<string, RecordAuthority>,
  other: RecordAuthority = "placeholders",
): OwnedPushDelivery {
  return (loaderId) => table[loaderId] ?? other;
}

/** A record hit, as CacheScope.lookupRouteDetailed restores it. */
function restore(
  store: Store,
  handles: Record<string, SegmentHandleData>,
  owners: HandleOwners | undefined,
  owned?: OwnedPushDelivery,
): void {
  if (owned) store.setRecordAuthority(owned);
  restoreHandles(handles, store, owners, owned);
}

/** A push by loader `id`'s live run, as the loader executor scopes it. */
function livePush(
  store: Store,
  id: string,
  value: unknown,
  segmentId = "seg1",
): void {
  runInsideLoaderScope(() =>
    runInsideLoaderBodyScope(() => store.push("crumbs", segmentId, value), id),
  );
}

const RECORD = {
  seg1: { crumbs: ["handler", "bake-captured", "live-captured"] },
};
const OWNERS = { seg1: { crumbs: [null, "Bake", "Live"] } };
const PINNED = delivery({ Bake: "pin", Live: "hole" });
const UNPINNED = delivery({ Bake: "hole", Live: "hole" });

describe("restoreHandles: a record's loader-owned values follow the loader's pin", () => {
  it("a pinned loader's copy stands: its settled push on this request is dropped", () => {
    const store = createHandleStore();
    restore(store, RECORD, OWNERS, PINNED);

    livePush(store, "Bake", "bake-live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-captured",
      "live-captured",
    ]);
  });

  it("a pinned loader's thenable push is added: the record could not keep it", () => {
    const store = createHandleStore();
    restore(store, RECORD, OWNERS, PINNED);
    const deferred = Promise.resolve("bake-deferred");

    livePush(store, "Bake", deferred);

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      deferred,
      "bake-captured",
      "live-captured",
    ]);
  });

  // A pin written before captures recorded every push ("copies"), and a
  // dependency of pinned loaders: the copies stand all the same.
  it('a "copies" owner stands like a pinned one', () => {
    const store = createHandleStore();
    restore(store, RECORD, OWNERS, delivery({ Bake: "copies", Live: "hole" }));

    livePush(store, "Bake", "bake-live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-captured",
      "live-captured",
    ]);
  });

  it("an unpinned loader's copy is a placeholder: its run's push takes its place", () => {
    const store = createHandleStore();
    restore(store, RECORD, OWNERS, PINNED);

    livePush(store, "Live", "live-live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-captured",
      "live-live",
    ]);
  });

  it("an unpinned loader's run that ends without a push drops the placeholder", () => {
    const store = createHandleStore();
    restore(store, RECORD, OWNERS, PINNED);

    store.settleLoaderRun("Live");
    // A pinned loader's copy is not a placeholder: its run ending keeps it.
    store.settleLoaderRun("Bake");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-captured",
    ]);
  });

  // The entry lost its pins (a navigation-only entry, `maxSnapshotBytes`), or
  // the record is a route cache() record: the same `ssr: false` loader that
  // stands above is a placeholder here, because it runs.
  it("without a pin every owner is a placeholder, a bake-lane loader included", () => {
    const store = createHandleStore();
    restore(store, RECORD, OWNERS, UNPINNED);

    livePush(store, "Bake", "bake-live");
    store.settleLoaderRun("Live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-live",
    ]);
  });

  it('a "placeholders" owner (a dependency while a pin is missing) gives way to its run', () => {
    const store = createHandleStore();
    restore(
      store,
      { seg1: { crumbs: ["dep-captured"] } },
      { seg1: { crumbs: ["Dependency"] } },
      UNPINNED,
    );

    store.settleLoaderRun("Dependency");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([]);
  });

  // A record with owners on a route that is no longer a ppr route (a deploy
  // changed it): withCacheLookup passes no delivery.
  it("without a delivery every owner is a placeholder", () => {
    const store = createHandleStore();
    restore(store, RECORD, OWNERS);

    livePush(store, "Bake", "bake-live");
    store.settleLoaderRun("Live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-live",
    ]);
  });

  it("a record without owners restores as a plain replay", () => {
    const store = createHandleStore();
    restore(store, { seg1: { crumbs: ["handler"] } }, undefined, UNPINNED);

    livePush(store, "Live", "live-live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "live-live",
    ]);
  });

  // The registered loaders without a pin are holes even with no copy in the
  // record: a push made in one's body is not a pinned loader's.
  it("a registered loader without a copy is a hole next to a pinned loader's copies", () => {
    const store = createHandleStore();
    restore(
      store,
      { seg1: { crumbs: ["bake-captured"] } },
      { seg1: { crumbs: ["Bake"] } },
      delivery({ Bake: "pin", Late: "hole" }),
    );

    // The pinned loader awaits the hole: the hole's push is made inside the
    // pinned loader's body.
    runInsideLoaderBodyScope(
      () =>
        runInsideLoaderBodyScope(
          () => store.push("crumbs", "seg1", "late-live"),
          "Late",
        ),
      "Bake",
    );

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "bake-captured",
      "late-live",
    ]);
  });

  it("nothing claims an owner: the loader's own cache() HIT still delivers", () => {
    const store = createHandleStore();
    restore(store, RECORD, OWNERS, UNPINNED);

    appendHandles(
      { "1:Bake": { crumbs: ["bake-entry"] } },
      store,
      "seg1",
      () => true,
      "Bake",
    );

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-entry",
      "live-captured",
    ]);
  });
});

describe("appendHandles: a cached unit's HIT over a record's placeholders", () => {
  const ENTRY = {
    "1:": { crumbs: ["own"] },
    "2:Dep": { crumbs: ["dep-entry"] },
  };
  const DEP_RECORD = { seg1: { crumbs: ["handler", "dep-captured"] } };
  const DEP_OWNERS = { seg1: { crumbs: [null, "Dep"] } };

  it("a claimed loader's placeholders give way to the entry's copy: the push shows once", () => {
    const store = createHandleStore();
    restore(store, DEP_RECORD, DEP_OWNERS, UNPINNED);
    const claimed: string[] = [];

    appendHandles(ENTRY, store, "seg1", (loaderId) => {
      claimed.push(loaderId);
      return true;
    });

    expect(claimed).toEqual(["Dep"]);
    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "dep-entry",
      "own",
    ]);
  });

  it("a refused claim leaves the placeholders and skips the entry's copy", () => {
    const store = createHandleStore();
    restore(store, DEP_RECORD, DEP_OWNERS, UNPINNED);

    appendHandles(ENTRY, store, "seg1", () => false);

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "dep-captured",
      "own",
    ]);
  });

  // A stale refresh's pushes are diverted by its capture: removing the
  // page's placeholders for them would leave the page without the push.
  it("without a claim (a stale refresh) every group is delivered and the placeholders stay", () => {
    const store = createHandleStore();
    restore(store, DEP_RECORD, DEP_OWNERS, UNPINNED);

    appendHandles(ENTRY, store, "seg1", undefined);

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "dep-captured",
      "own",
      "dep-entry",
    ]);
  });

  it("a pinned loader's copy stands against the entry's settled copy", () => {
    const store = createHandleStore();
    restore(store, DEP_RECORD, DEP_OWNERS, delivery({ Dep: "copies" }));

    appendHandles(ENTRY, store, "seg1", () => true);

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "dep-captured",
      "own",
    ]);
  });

  describe("a loader's own cache() entry (unitLoader)", () => {
    const BAKE_RECORD = {
      seg1: { crumbs: ["bake-captured", "handler", "dep-captured"] },
    };
    const BAKE_OWNERS = { seg1: { crumbs: ["Bake", null, "Dep"] } };

    it("asks the claim once per loader, the cached loader first", () => {
      const store = createHandleStore();
      const claimed: string[] = [];

      appendHandles(
        {
          "1:Dep": { crumbs: ["dep-a"] },
          "2:Bake": { crumbs: ["bake"] },
          "3:Dep": { crumbs: ["dep-b"] },
        },
        store,
        "seg1",
        (loaderId) => {
          claimed.push(loaderId);
          return true;
        },
        "Bake",
      );

      expect(claimed).toEqual(["Bake", "Dep"]);
      expect(store.getDataForSegment("seg1").crumbs).toEqual([
        "dep-a",
        "bake",
        "dep-b",
      ]);
    });

    // The entry is the loader's source on this request, pushes or none: a
    // reader-first MISS, or an encode timeout, wrote it without handles.
    it("an entry that recorded no push removes the cached loader's placeholders, and no other loader's", () => {
      const store = createHandleStore();
      restore(store, BAKE_RECORD, BAKE_OWNERS, UNPINNED);

      appendHandles({}, store, "seg1", () => true, "Bake");

      expect(store.getDataForSegment("seg1").crumbs).toEqual([
        "handler",
        "dep-captured",
      ]);
    });

    it("a refused claim for the cached loader leaves its placeholders to the run that claimed it", () => {
      const store = createHandleStore();
      restore(store, BAKE_RECORD, BAKE_OWNERS, UNPINNED);

      appendHandles(
        { "1:Bake": { crumbs: ["bake-entry"] } },
        store,
        "seg1",
        () => false,
        "Bake",
      );

      expect(store.getDataForSegment("seg1").crumbs).toEqual([
        "bake-captured",
        "handler",
        "dep-captured",
      ]);
    });

    it("without a claim the entry is delivered and the placeholders stay", () => {
      const store = createHandleStore();
      restore(store, BAKE_RECORD, BAKE_OWNERS, UNPINNED);

      appendHandles(
        { "1:Bake": { crumbs: ["bake-entry"] } },
        store,
        "seg1",
        undefined,
        "Bake",
      );

      expect(store.getDataForSegment("seg1").crumbs).toEqual([
        "bake-captured",
        "handler",
        "dep-captured",
        "bake-entry",
      ]);
    });

    // An entry written before owner keys is keyed by segment id.
    it("a group without an owner is the cached loader's: its later run replaces it", () => {
      const store = createHandleStore();

      appendHandles(
        { L1: { crumbs: ["bake-legacy"] } },
        store,
        "seg1",
        () => true,
        "Bake",
      );
      livePush(store, "Bake", "bake-live");

      expect(store.getDataForSegment("seg1").crumbs).toEqual(["bake-live"]);
    });
  });

  // A "use cache" function's own pushes are no loader's: nothing is asked.
  it("a function's group without an owner is a plain push", () => {
    const store = createHandleStore();
    const claimed: string[] = [];

    appendHandles(
      { "1:": { crumbs: ["own"] }, seg9: { crumbs: ["legacy"] } },
      store,
      "seg1",
      (loaderId) => {
        claimed.push(loaderId);
        return true;
      },
    );

    expect(claimed).toEqual([]);
    expect(store.getDataForSegment("seg1").crumbs).toEqual(["own", "legacy"]);
  });
});

// A prerender-served shell capture's record (issue #1057): the prerender
// store restores the handler pushes on a HIT, so the record keeps only the
// arrays a loader pushed into, each whole.
describe("captureOwnedHandles: the arrays that hold a loader-owned value", () => {
  it("keeps each such array whole, its unowned values in place, and nothing else", () => {
    const store = createHandleStore();
    store.push("crumbs", "seg1", "handler");
    store.push("crumbs", "seg1", "bake-captured", false, "Bake");
    store.push("meta", "seg1", "handler-meta");
    store.push("crumbs", "seg2", "layout");
    // A tagged push (deferred, masked) is out of a record, owned or not.
    store.push("crumbs", "seg1", "tagged", true);

    expect(captureOwnedHandles(store)).toEqual({
      handles: { seg1: { crumbs: ["handler", "bake-captured"] } },
      owners: { seg1: { crumbs: [null, "Bake"] } },
    });
  });

  it("holds nothing when no value is owned", () => {
    const store = createHandleStore();
    store.push("crumbs", "seg1", "handler");

    expect(captureOwnedHandles(store)).toEqual({
      handles: {},
      owners: undefined,
    });
  });

  it("rebuilds the capture's array over a store that already holds the handler pushes", () => {
    const capture = createHandleStore();
    capture.push("crumbs", "seg1", "handler");
    capture.push("crumbs", "seg1", "bake-captured", false, "Bake");
    const { handles, owners } = captureOwnedHandles(capture);
    const hit = createHandleStore();
    hit.replaySegmentData("seg1", { crumbs: ["handler"] });

    restore(hit, handles, owners, PINNED);
    livePush(hit, "Bake", "bake-live");

    expect(hit.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-captured",
    ]);
  });
});
