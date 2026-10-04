/**
 * loaderPins: what a restored record is to each loader's handle pushes
 * (HandleStore RecordAuthority), the answer a record's restore takes for the
 * loader-owned values it holds (handle-snapshot.ts restoreHandles). It reads
 * the pins resolveLoaderData serves a loader's value from, by loader id, so
 * the two cannot disagree.
 */
import { describe, it, expect, vi } from "vitest";

const mockRequestCtx: any = {
  _shellCaptureRun: undefined,
  _shellLoaderSeed: undefined,
  executionContext: undefined,
  params: {},
};

vi.mock("../../../server/request-context.js", () => ({
  getRequestContext: vi.fn(() => mockRequestCtx),
  _getRequestContext: vi.fn(() => mockRequestCtx),
  runWithRequestContext: <T>(_c: unknown, fn: () => T): T => fn(),
}));

// loader-cache.ts reaches segment-codec lazily; nothing here encodes.
vi.mock("../../../cache/segment-codec.js", () => ({
  serializeResult: vi.fn(),
  deserializeResult: vi.fn(),
}));

import { loaderPins, resolveLoaderData } from "../loader-cache.js";
import type { EntryData, LoaderEntry } from "../../../server/context.js";
import type { ShellLoaderSeedEntry } from "../../../cache/shell-snapshot.js";
import type { RequestContext } from "../../../server/request-context.js";

const PIN: ShellLoaderSeedEntry = {
  container: { from: "pin" },
  holes: false,
  runs: false,
  complete: true,
};
/** A pin stored before captures recorded every push (no `runs` bit). */
const LEGACY_PIN: ShellLoaderSeedEntry = {
  container: { from: "pin" },
  holes: true,
  runs: true,
  complete: false,
};

function loaderEntry(id: string, bake: boolean): LoaderEntry {
  const loader = Object.assign(
    vi.fn(async () => ({ from: "run" })),
    { __brand: "loader", $$id: id },
  );
  return {
    loader,
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
  pins?: Record<string, ShellLoaderSeedEntry>,
  capture = false,
): RequestContext<any> {
  return {
    _shellCaptureRun: capture || undefined,
    _shellLoaderSeed: pins ? new Map(Object.entries(pins)) : undefined,
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
  const ALL = { "LayoutBake#L": PIN, "RouteBake#L": PIN };

  it('a bake-lane loader with a pin is "pin"; a live-lane loader is a hole', () => {
    const authority = loaderPins(entries, request(ALL));

    expect(authority("LayoutBake#L")).toBe("pin");
    expect(authority("RouteBake#L")).toBe("pin");
    expect(authority("RouteLive#L")).toBe("hole");
  });

  it('a pin without the `runs` bit is "copies": its record may hold no push of the loader', () => {
    const authority = loaderPins(
      entries,
      request({ "LayoutBake#L": LEGACY_PIN, "RouteBake#L": PIN }),
    );

    expect(authority("LayoutBake#L")).toBe("copies");
    expect(authority("RouteBake#L")).toBe("pin");
  });

  it("without a seed nothing is pinned: every registered loader is a hole", () => {
    const authority = loaderPins(entries, request());

    expect(authority("LayoutBake#L")).toBe("hole");
    expect(authority("RouteBake#L")).toBe("hole");
    expect(authority("RouteLive#L")).toBe("hole");
  });

  it("a capture serves no pin, whatever seed its context inherits", () => {
    const authority = loaderPins(entries, request(ALL, true));

    expect(authority("RouteBake#L")).toBe("hole");
    expect(authority("Dependency#L")).toBe("placeholders");
  });

  it("a pin the seed lost leaves that loader a hole, the others pinned", () => {
    const authority = loaderPins(entries, request({ "LayoutBake#L": PIN }));

    expect(authority("LayoutBake#L")).toBe("pin");
    expect(authority("RouteBake#L")).toBe("hole");
  });

  describe("a dependency the route does not register", () => {
    it('is "copies" while every ssr: false loader is pinned', () => {
      expect(loaderPins(entries, request(ALL))("Dependency#L")).toBe("copies");
    });

    it('is "placeholders", and no hole, once one of them lost its pin, or without a seed', () => {
      expect(
        loaderPins(entries, request({ "LayoutBake#L": PIN }))("Dependency#L"),
      ).toBe("placeholders");
      expect(loaderPins(entries, request())("Dependency#L")).toBe(
        "placeholders",
      );
    });

    it('is "placeholders" on a route without an ssr: false loader', () => {
      const liveOnly = [entry("R0", [loaderEntry("RouteLive#L", false)])];

      expect(
        loaderPins(liveOnly, request({ "RouteLive#L": PIN }))("Dependency#L"),
      ).toBe("placeholders");
    });
  });

  it("a loader the route also registers without ssr: false is a hole, whatever pin its other registration has", () => {
    const both = [
      entry("L0", [loaderEntry("Shared#L", true)]),
      entry("L0R1", [loaderEntry("Shared#L", false)]),
    ];
    const authority = loaderPins(both, request({ "Shared#L": PIN }));

    expect(authority("Shared#L")).toBe("hole");
    // No ssr: false loader is pinned, so a dependency's copies do not stand.
    expect(authority("Dependency#L")).toBe("placeholders");
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
    const authority = loaderPins(
      nested,
      request({ "RouteBake#L": PIN, "OrphanBake#L": PIN, "SlotBake#L": PIN }),
    );

    expect(authority("OrphanBake#L")).toBe("pin");
    expect(authority("SlotBake#L")).toBe("pin");
    expect(authority("Dependency#L")).toBe("copies");
  });

  // matchPartialWithPprReplay arms the seed for the match and restores the
  // previous value after it, while loader bodies still run and push.
  it("keeps the answer of the pins it was built over when the seed is disarmed", () => {
    const reqCtx = request(ALL);
    const authority = loaderPins(entries, reqCtx);

    reqCtx._shellLoaderSeed = undefined;

    expect(authority("RouteBake#L")).toBe("pin");
    expect(authority("Dependency#L")).toBe("copies");
  });
});

/**
 * The value and the pushes look a loader up in the same pins, by loader id:
 * the registration that serves its value from the pin is the loader whose
 * record copies stand.
 */
describe("the pin a loader's value is served from is the pin its pushes follow", () => {
  const ctx = { params: {}, use: (loader: any) => loader() } as any;

  async function served(
    loader: LoaderEntry,
    pins: Record<string, ShellLoaderSeedEntry> | undefined,
    key: string | null = "R0D0.x",
  ): Promise<string> {
    mockRequestCtx._shellLoaderSeed = pins
      ? new Map(Object.entries(pins))
      : undefined;
    try {
      return (await resolveLoaderData(loader, ctx, "/x", key)).from;
    } finally {
      mockRequestCtx._shellLoaderSeed = undefined;
    }
  }

  const bake = loaderEntry("Bake#L", true);
  const live = loaderEntry("Live#L", false);
  const route = [entry("R0", [bake, live])];
  const pins = { "Bake#L": PIN };

  it("an ssr: false loader with a pin: the value is the pin's and its copies stand", async () => {
    expect(await served(bake, pins)).toBe("pin");
    expect(loaderPins(route, request(pins))("Bake#L")).toBe("pin");
  });

  it("the same loader without a pin: the value is the run's and its copies are placeholders", async () => {
    expect(await served(bake, undefined)).toBe("run");
    expect(loaderPins(route, request())("Bake#L")).toBe("hole");
  });

  // The pin is found by loader id, whatever segment the capture stored it
  // under and whatever segment resolves the loader now.
  it("the segment key does not decide: another registration's key serves the same pin", async () => {
    expect(await served(bake, pins, "L7D3.x")).toBe("pin");
  });

  // An entry without loading() passes its key for every loader (fresh.ts
  // resolveLoaders); only the `ssr: false` registration is on the bake lane.
  it("a loader registered without ssr: false runs, pin or no pin, and is a hole", async () => {
    const stale = { "Live#L": PIN };

    expect(await served(live, stale)).toBe("run");
    expect(loaderPins(route, request(stale))("Live#L")).toBe("hole");
  });

  it("a caller that passes no key (an intercept, a loaders-only resolution) runs the loader", async () => {
    expect(await served(bake, pins, null)).toBe("run");
  });

  // The value is per registration and the pushes are per loader. The
  // `ssr: false` registration is served its pin (the prelude holds it); the
  // capture credited the loader's pushes to the live registration's run.
  it("a loader registered on both lanes: its ssr: false registration is served the pin, its pushes follow the live run", async () => {
    const both = [
      entry("L0", [bake]),
      entry("L0R1", [loaderEntry("Bake#L", false)]),
    ];

    expect(await served(bake, pins)).toBe("pin");
    expect(loaderPins(both, request(pins))("Bake#L")).toBe("hole");
  });
});
