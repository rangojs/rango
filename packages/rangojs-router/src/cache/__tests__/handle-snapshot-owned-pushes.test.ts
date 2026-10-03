/**
 * restoreHandles and appendHandles over a record's loader-owned values: a
 * copy stands only where the record also supplies the loader's value (a
 * pin); everywhere else it is a placeholder the loader's own source replaces
 * (docs/design/handle-push-ownership.md).
 */
import { describe, it, expect } from "vitest";
import {
  appendHandles,
  restoreHandles,
  type OwnedPushDelivery,
} from "../handle-snapshot.js";
import { createHandleStore } from "../../server/handle-store.js";
import {
  runInsideLoaderBodyScope,
  runInsideLoaderScope,
} from "../../server/context.js";

/** A delivery over fixed sets, as loaderPins answers from the seed. */
function delivery(options: {
  pinned?: string[];
  unpinned?: string[];
  seeded?: boolean;
}): OwnedPushDelivery & { asked: string[] } {
  const pinned = new Set(options.pinned ?? []);
  const asked: string[] = [];
  return {
    asked,
    seeded: options.seeded ?? pinned.size > 0,
    pinned(loaderId) {
      asked.push(loaderId);
      return pinned.has(loaderId);
    },
    unpinned: () => new Set(options.unpinned ?? []),
  };
}

/** A push by loader `id`'s live run, as the loader executor scopes it. */
function livePush(
  store: ReturnType<typeof createHandleStore>,
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

describe("restoreHandles: a record's loader-owned values follow the loader's pin", () => {
  it("a pinned loader's copy stands: its settled push on this request is dropped", () => {
    const store = createHandleStore();
    restoreHandles(
      RECORD,
      store,
      OWNERS,
      delivery({ pinned: ["Bake"], unpinned: ["Live"] }),
    );

    livePush(store, "Bake", "bake-live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-captured",
      "live-captured",
    ]);
  });

  it("a pinned loader's thenable push is added: the record could not keep it", () => {
    const store = createHandleStore();
    restoreHandles(
      RECORD,
      store,
      OWNERS,
      delivery({ pinned: ["Bake"], unpinned: ["Live"] }),
    );
    const deferred = Promise.resolve("bake-deferred");

    livePush(store, "Bake", deferred);

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      deferred,
      "bake-captured",
      "live-captured",
    ]);
  });

  it("an unpinned loader's copy is a placeholder: its run's push takes its place", () => {
    const store = createHandleStore();
    restoreHandles(
      RECORD,
      store,
      OWNERS,
      delivery({ pinned: ["Bake"], unpinned: ["Live"] }),
    );

    livePush(store, "Live", "live-live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-captured",
      "live-live",
    ]);
  });

  it("an unpinned loader's run that ends without a push drops the placeholder", () => {
    const store = createHandleStore();
    restoreHandles(
      RECORD,
      store,
      OWNERS,
      delivery({ pinned: ["Bake"], unpinned: ["Live"] }),
    );

    store.settleLoaderRun("Live");
    // A pinned loader's copy is not a replay: its run ending keeps it.
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
    restoreHandles(
      RECORD,
      store,
      OWNERS,
      delivery({ unpinned: ["Bake", "Live"] }),
    );

    livePush(store, "Bake", "bake-live");
    store.settleLoaderRun("Live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-live",
    ]);
  });

  it("an owner the route does not register is a hole once it is a placeholder", () => {
    const store = createHandleStore();
    restoreHandles(
      { seg1: { crumbs: ["dep-captured"] } },
      store,
      { seg1: { crumbs: ["Dependency"] } },
      // Not among the registered loaders the delivery lists.
      delivery({ unpinned: ["Bake"] }),
    );

    store.settleLoaderRun("Dependency");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([]);
  });

  it("without a delivery every owner is a placeholder", () => {
    const store = createHandleStore();
    restoreHandles(RECORD, store, OWNERS);

    livePush(store, "Bake", "bake-live");
    store.settleLoaderRun("Live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-live",
    ]);
  });

  it("nothing claims an owner: the loader's own cache() HIT still delivers", () => {
    const store = createHandleStore();
    restoreHandles(
      RECORD,
      store,
      OWNERS,
      delivery({ unpinned: ["Bake", "Live"] }),
    );

    // loader-cache.ts replayLoaderHandles, once its claim is granted.
    store.redeliverReplays(["Bake"], () => {
      store.pushReplayed("crumbs", "seg1", "bake-entry", "Bake");
    });

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-entry",
      "live-captured",
    ]);
  });

  describe("marking the holes", () => {
    // The registered loaders without a pin are holes even with no copy in
    // the record: a push made in one's body is not a pinned loader's.
    it("a registered loader without a copy is a hole next to a pinned loader's copies", () => {
      const store = createHandleStore();
      restoreHandles(
        { seg1: { crumbs: ["bake-captured"] } },
        store,
        { seg1: { crumbs: ["Bake"] } },
        delivery({ pinned: ["Bake"], unpinned: ["Late"] }),
      );

      // The pinned loader awaits the hole: the hole's push is made inside
      // the pinned loader's body.
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

    it("a record without owners on a seeded request still marks them", () => {
      const store = createHandleStore();
      restoreHandles(
        { seg1: { crumbs: ["handler"] } },
        store,
        undefined,
        delivery({ seeded: true, unpinned: ["Live"] }),
      );
      // A copy another cached unit's HIT replayed for the hole.
      store.pushReplayed("crumbs", "seg1", "live-cached", "Live");

      store.settleLoaderRun("Live");

      expect(store.getDataForSegment("seg1").crumbs).toEqual(["handler"]);
    });

    it("a record without owners on an unseeded request restores as a plain replay", () => {
      const store = createHandleStore();
      const owned = delivery({ seeded: false, unpinned: ["Live"] });
      restoreHandles(
        { seg1: { crumbs: ["handler"] } },
        store,
        undefined,
        owned,
      );
      store.pushReplayed("crumbs", "seg1", "live-cached", "Live");

      store.settleLoaderRun("Live");

      // Not a hole: a route without ppr keeps today's loader-cache rule.
      expect(store.getDataForSegment("seg1").crumbs).toEqual([
        "handler",
        "live-cached",
      ]);
      expect(owned.asked).toEqual([]);
    });
  });
});

describe('appendHandles: a "use cache" HIT over a record\'s placeholders', () => {
  const ENTRY = {
    "1:": { crumbs: ["own"] },
    "2:Dep": { crumbs: ["dep-entry"] },
  };

  it("a claimed loader's placeholders give way to the entry's copy: the push shows once", () => {
    const store = createHandleStore();
    restoreHandles(
      { seg1: { crumbs: ["handler", "dep-captured"] } },
      store,
      { seg1: { crumbs: [null, "Dep"] } },
      delivery({ unpinned: [] }),
    );
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
    restoreHandles(
      { seg1: { crumbs: ["dep-captured"] } },
      store,
      { seg1: { crumbs: ["Dep"] } },
      delivery({ unpinned: [] }),
    );

    appendHandles(ENTRY, store, "seg1", () => false);

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "dep-captured",
      "own",
    ]);
  });

  // A stale refresh's pushes are diverted by its capture: removing the
  // page's placeholders for them would leave the page without the push.
  it("without a claim (a stale refresh) the placeholders are left alone", () => {
    const store = createHandleStore();
    restoreHandles(
      { seg1: { crumbs: ["dep-captured"] } },
      store,
      { seg1: { crumbs: ["Dep"] } },
      delivery({ unpinned: [] }),
    );

    appendHandles(ENTRY, store, "seg1");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "dep-captured",
      "own",
      "dep-entry",
    ]);
  });

  it("a pinned loader's copy stands against the entry's settled copy", () => {
    const store = createHandleStore();
    restoreHandles(
      { seg1: { crumbs: ["dep-captured"] } },
      store,
      { seg1: { crumbs: ["Dep"] } },
      delivery({ pinned: ["Dep"] }),
    );

    appendHandles(ENTRY, store, "seg1", () => true);

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "dep-captured",
      "own",
    ]);
  });
});
