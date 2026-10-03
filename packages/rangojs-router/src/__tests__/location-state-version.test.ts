// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  initBrowserApp,
  resetBrowserAppContext,
} from "../browser/rsc-router.js";
import {
  buildHistoryState,
  mergeLocationState,
  resolveNavigationState,
} from "../browser/history-state.js";
import { createLocationState } from "../browser/react/location-state-shared.js";
import { withLocationStateKey } from "../testing/location-state-key.js";
import type {
  NavigationBridge,
  RscBrowserDependencies,
  RscPayload,
} from "../browser/types.js";

// Location state is versioned by the app version, with no option and no API:
// state written while the client ran one version reads as undefined once it
// runs another. The version comes in the way it does in production, with the
// document's payload (initBrowserApp), so every "document load" below is one.

type Grid = { rows: number[] };

const GridState = withLocationStateKey(createLocationState<Grid>(), "Grid");
const SortState = withLocationStateKey(
  createLocationState<{ order: string }>(),
  "Sort",
);

/** A document load of the current entry under `version`. */
async function loadDocument(
  version: string | undefined,
): Promise<NavigationBridge> {
  resetBrowserAppContext();
  const payload = {
    metadata: { version, pathname: "/", segments: [], matched: [], params: {} },
  } as unknown as RscPayload;
  const { bridge } = await initBrowserApp({
    rscStream: new ReadableStream<Uint8Array>(),
    deps: {
      createFromReadableStream: async () => payload,
      createFromFetch: async () => payload,
      setServerCallback: () => {},
      encodeReply: async () => "",
      createTemporaryReferenceSet: () => ({}),
    } as unknown as RscBrowserDependencies,
    linkInterception: false,
  });
  return bridge;
}

/** What a navigation leaves on the entry it pushes or replaces. */
function navigateWithState(state: unknown): void {
  window.history.replaceState(
    buildHistoryState(resolveNavigationState(state)),
    "",
  );
}

function locationStateOf(entry: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry as Record<string, unknown>).filter(
      ([key]) => key === "state" || key.startsWith("__rsc_ls_"),
    ),
  );
}

afterEach(async () => {
  window.history.replaceState(null, "");
  await loadDocument(undefined);
});

describe("location state is versioned by the app version", () => {
  const grid: Grid = { rows: [1, 2] };

  it.each([
    ["Def.write()", () => GridState.write(grid)],
    [
      "a navigation with typed state",
      () => navigateWithState([GridState(grid)]),
    ],
    [
      "server-set state merged from a payload",
      () => mergeLocationState({ [GridState.__rsc_ls_key]: grid }),
    ],
  ])(
    "%s: read under the same version, undefined after a document load under another",
    async (_label, write) => {
      await loadDocument("build-1");
      write();
      expect(GridState.read()).toEqual(grid);

      await loadDocument("build-1");
      expect(GridState.read()).toEqual(grid);
      expect(GridState.read({ state: window.history.state })).toEqual(grid);

      await loadDocument("build-2");
      expect(GridState.read()).toBeUndefined();
      expect(GridState.read({ state: window.history.state })).toBeUndefined();
    },
  );

  it("an entry with no recorded version reads undefined once the client has a version", async () => {
    // What a release older than this behavior, or code outside the router,
    // left on the entry.
    window.history.replaceState({ [GridState.__rsc_ls_key]: grid, idx: 2 }, "");

    await loadDocument("build-1");
    expect(GridState.read()).toBeUndefined();
  });

  it("a write under another version does not bring back what the older version left", async () => {
    await loadDocument("build-1");
    navigateWithState({ from: "list" });
    GridState.write(grid);
    SortState.write({ order: "asc" });
    window.history.replaceState(
      { ...window.history.state, idx: 3, key: "scroll-key", intercept: true },
      "",
    );

    await loadDocument("build-2");
    for (const write of [
      () => SortState.write({ order: "desc" }),
      () => mergeLocationState({ [SortState.__rsc_ls_key]: { order: "desc" } }),
    ]) {
      const before = window.history.state;
      write();
      expect(SortState.read()).toEqual({ order: "desc" });
      expect(GridState.read()).toBeUndefined();
      expect(locationStateOf(window.history.state)).toEqual({
        [SortState.__rsc_ls_key]: { order: "desc" },
      });
      // Router bookkeeping on the entry is not location state.
      expect(window.history.state).toMatchObject({
        idx: 3,
        key: "scroll-key",
        intercept: true,
      });
      window.history.replaceState(before, "");
    }
  });

  it("stamps only entries that carry location state, with one field", async () => {
    await loadDocument("build-1");

    expect(buildHistoryState(undefined)).toBeNull();
    expect(buildHistoryState(undefined, { intercept: true })).toEqual({
      intercept: true,
    });
    expect(buildHistoryState({ from: "list" })).toEqual({
      state: { from: "list" },
      __rsc_lsv: "build-1",
    });
    navigateWithState([GridState(grid)]);
    expect(window.history.state).toEqual({
      [GridState.__rsc_ls_key]: grid,
      __rsc_lsv: "build-1",
    });
  });

  it("a client without a version neither stamps nor compares", async () => {
    await loadDocument(undefined);
    GridState.write(grid);
    expect(locationStateOf(window.history.state)).toEqual({
      [GridState.__rsc_ls_key]: grid,
    });
    expect(window.history.state).not.toHaveProperty("__rsc_lsv");
    expect(GridState.read()).toEqual(grid);
  });

  // Dev: an RSC module edit bumps the app version in a running client
  // (rsc-router.tsx HMR handler -> bridge.updateVersion). That must not drop
  // the session's location state; the next document load does.
  it("an HMR version bump in a running session keeps the state", async () => {
    const bridge = await loadDocument("dev-1");
    GridState.write(grid);

    bridge.updateVersion("dev-2");
    expect(bridge.getVersion()).toBe("dev-2");
    expect(GridState.read()).toEqual(grid);
    SortState.write({ order: "asc" });
    expect(GridState.read()).toEqual(grid);
    expect(SortState.read()).toEqual({ order: "asc" });

    await loadDocument("dev-2");
    expect(GridState.read()).toBeUndefined();
    expect(SortState.read()).toBeUndefined();
  });
});
