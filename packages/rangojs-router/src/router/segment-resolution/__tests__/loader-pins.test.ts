/**
 * loaderPins: which loaders a request serves from a shell pin, the answer a
 * record's restore takes for the loader-owned handle values it holds
 * (handle-snapshot.ts restoreHandles). It reads the seed resolveLoaderData
 * serves a loader's value from, so the two cannot disagree.
 */
import { describe, it, expect, vi } from "vitest";

// loader-cache.ts reaches segment-codec lazily; nothing here encodes.
vi.mock("../../../cache/segment-codec.js", () => ({
  serializeResult: vi.fn(),
  deserializeResult: vi.fn(),
}));

import { loaderPins } from "../loader-cache.js";
import type { EntryData, LoaderEntry } from "../../../server/context.js";
import type { ShellLoaderSeedEntry } from "../../../cache/shell-snapshot.js";
import type { RequestContext } from "../../../server/request-context.js";

const PIN: ShellLoaderSeedEntry = { container: {}, holes: false, runs: false };

function loaderEntry(id: string, bake: boolean): LoaderEntry {
  return {
    loader: { __brand: "loader", $$id: id },
    revalidate: [],
    ...(bake ? { bake: true } : {}),
  } as unknown as LoaderEntry;
}

function entry(
  shortCode: string,
  loaders: LoaderEntry[],
  extra: Partial<EntryData> = {},
): EntryData {
  return {
    id: shortCode,
    shortCode,
    type: "route",
    loader: loaders,
    layout: [],
    parallel: {},
    ...extra,
  } as unknown as EntryData;
}

function request(
  seedKeys?: string[],
  capture = false,
): RequestContext<any> & { _shellLoaderSeed?: Map<string, unknown> } {
  return {
    _shellCaptureRun: capture || undefined,
    _shellLoaderSeed: seedKeys
      ? new Map(seedKeys.map((key) => [key, PIN]))
      : undefined,
  } as any;
}

describe("loaderPins", () => {
  const entries = [
    entry("L0", [loaderEntry("LayoutBake#L", true)]),
    entry("L0R1", [
      loaderEntry("RouteBake#L", true),
      loaderEntry("RouteLive#L", false),
    ]),
  ];

  it("a bake-lane loader with a pin is pinned; a live-lane loader never is", () => {
    const pins = loaderPins(
      entries,
      request(["L0D0.LayoutBake#L", "L0R1D0.RouteBake#L"]),
    );

    expect(pins.seeded).toBe(true);
    expect(pins.pinned("LayoutBake#L")).toBe(true);
    expect(pins.pinned("RouteBake#L")).toBe(true);
    expect(pins.pinned("RouteLive#L")).toBe(false);
    expect([...pins.unpinned()]).toEqual(["RouteLive#L"]);
  });

  it("without a seed nothing is pinned: every registered loader is a hole", () => {
    const pins = loaderPins(entries, request());

    expect(pins.seeded).toBe(false);
    expect(pins.pinned("LayoutBake#L")).toBe(false);
    expect(pins.pinned("RouteBake#L")).toBe(false);
    expect([...pins.unpinned()].sort()).toEqual([
      "LayoutBake#L",
      "RouteBake#L",
      "RouteLive#L",
    ]);
  });

  it("a capture serves no pin, whatever seed its context inherits", () => {
    const pins = loaderPins(
      entries,
      request(["L0D0.LayoutBake#L", "L0R1D0.RouteBake#L"], true),
    );

    expect(pins.seeded).toBe(false);
    expect(pins.pinned("RouteBake#L")).toBe(false);
    expect(pins.unpinned().size).toBe(3);
  });

  it("a pin the seed lost leaves that loader a hole, the others pinned", () => {
    const pins = loaderPins(entries, request(["L0D0.LayoutBake#L"]));

    expect(pins.pinned("LayoutBake#L")).toBe(true);
    expect(pins.pinned("RouteBake#L")).toBe(false);
    expect([...pins.unpinned()].sort()).toEqual(["RouteBake#L", "RouteLive#L"]);
  });

  describe("a dependency the route does not register", () => {
    it("counts as pinned while every ssr: false loader is", () => {
      const pins = loaderPins(
        entries,
        request(["L0D0.LayoutBake#L", "L0R1D0.RouteBake#L"]),
      );

      expect(pins.pinned("Dependency#L")).toBe(true);
      // Not a hole either way: it is not a registered loader.
      expect(pins.unpinned().has("Dependency#L")).toBe(false);
    });

    it("is not once one of them lost its pin, or without a seed", () => {
      expect(
        loaderPins(entries, request(["L0D0.LayoutBake#L"])).pinned(
          "Dependency#L",
        ),
      ).toBe(false);
      expect(loaderPins(entries, request()).pinned("Dependency#L")).toBe(false);
    });

    it("is not on a route without an ssr: false loader", () => {
      const liveOnly = [entry("R0", [loaderEntry("RouteLive#L", false)])];

      expect(
        loaderPins(liveOnly, request(["R0D0.RouteLive#L"])).pinned(
          "Dependency#L",
        ),
      ).toBe(false);
    });
  });

  it("a loader the route also registers without ssr: false is a hole, whatever pin its other registration has", () => {
    const both = [
      entry("L0", [loaderEntry("Shared#L", true)]),
      entry("L0R1", [loaderEntry("Shared#L", false)]),
    ];
    const pins = loaderPins(both, request(["L0D0.Shared#L"]));

    expect(pins.pinned("Shared#L")).toBe(false);
    expect([...pins.unpinned()]).toEqual(["Shared#L"]);
    // No ssr: false loader is pinned, so a dependency is not either.
    expect(pins.pinned("Dependency#L")).toBe(false);
  });

  it("reads the loaders of orphan layouts and parallel slots", () => {
    const nested = [
      entry("R0", [loaderEntry("RouteBake#L", true)], {
        layout: [entry("R0L0", [loaderEntry("OrphanBake#L", true)])],
        parallel: {
          "@side": entry("R0P0", [loaderEntry("SlotBake#L", true)]),
        },
      } as Partial<EntryData>),
    ];
    const pins = loaderPins(
      nested,
      request(["R0D0.RouteBake#L", "R0L0D0.OrphanBake#L", "R0D0.SlotBake#L"]),
    );

    expect(pins.pinned("OrphanBake#L")).toBe(true);
    expect(pins.pinned("SlotBake#L")).toBe(true);
    expect(pins.unpinned().size).toBe(0);
  });

  // A pin's key is `${shortCode}D${index}.${loaderId}`: a shortCode holds no
  // "D" and no ".", a loader id can hold both.
  it("names the pin's loader from its key, for ids and shortCodes of every shape", () => {
    const ids = [
      "src/loaders.ts#Product",
      "D:/app/src/a.bD2.loaders.ts#Detail",
      "a1b2c3#D0.x",
    ];
    const shaped = [
      entry("M0L0", [loaderEntry(ids[0], true)]),
      entry("M0L0I0R12", [
        loaderEntry(ids[1], true),
        loaderEntry(ids[2], true),
      ]),
    ];
    const pins = loaderPins(
      shaped,
      request([
        `M0L0D0.${ids[0]}`,
        `M0L0I0R12D0.${ids[1]}`,
        `M0L0I0R12D1.${ids[2]}`,
      ]),
    );

    for (const id of ids) expect(pins.pinned(id), id).toBe(true);
    expect(pins.unpinned().size).toBe(0);
  });

  it("ignores a key that is not a loader segment id", () => {
    const pins = loaderPins(
      entries,
      request(["L0D0.LayoutBake#L", "not-a-pin.RouteBake#L"]),
    );

    expect(pins.pinned("RouteBake#L")).toBe(false);
  });

  // withCacheLookup builds it before its lookup; a navigation replay arms the
  // seed when that lookup hits (CacheScope.lookupRouteDetailed onHit).
  it("answers from the seed as it is when asked, not when built", () => {
    const reqCtx = request();
    const pins = loaderPins(entries, reqCtx);
    expect(pins.seeded).toBe(false);
    expect(pins.pinned("RouteBake#L")).toBe(false);

    reqCtx._shellLoaderSeed = new Map([
      ["L0D0.LayoutBake#L", PIN],
      ["L0R1D0.RouteBake#L", PIN],
    ]);

    expect(pins.seeded).toBe(true);
    expect(pins.pinned("RouteBake#L")).toBe(true);
    expect([...pins.unpinned()]).toEqual(["RouteLive#L"]);

    reqCtx._shellLoaderSeed = undefined;
    expect(pins.pinned("RouteBake#L")).toBe(false);
  });
});
