// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import * as rootEntry from "../index.js";
import * as clientEntry from "../client.js";
import * as browserEntry from "../browser/index.js";
import * as testingEntry from "../testing/index.js";
import * as testingDomEntry from "../testing/dom.entry.js";
import { resetBrowserAppContext } from "../browser/rsc-router.js";
import { mergeLocationState } from "../browser/history-state.js";
import type { RscBrowserDependencies, RscPayload } from "../browser/types.js";

// The version location state is recorded under is not an API: the app author
// neither sets nor reads it. Pinned from the public entries, with a client
// running a version no other string in the process can equal.

const SENTINEL = "location-state-version-sentinel-7f3a";

const ENTRIES: Record<string, Record<string, unknown>> = {
  "@rangojs/router": rootEntry,
  "@rangojs/router/client": clientEntry,
  "@rangojs/router/browser": browserEntry,
  "@rangojs/router/testing": testingEntry,
  "@rangojs/router/testing/dom": testingDomEntry,
};

async function loadDocument(version: string | undefined): Promise<void> {
  resetBrowserAppContext();
  const payload = {
    metadata: { version, pathname: "/", segments: [], matched: [], params: {} },
  } as unknown as RscPayload;
  await browserEntry.initBrowserApp({
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
}

/**
 * Every string an export holds, without calling anything: own properties
 * (getters included) down to `depth`.
 */
function heldStrings(
  value: unknown,
  depth: number,
  seen: Set<unknown>,
): string[] {
  if (typeof value === "string") return [value];
  if (value === null) return [];
  if (typeof value !== "object" && typeof value !== "function") return [];
  if (depth === 0 || seen.has(value)) return [];
  seen.add(value);
  return Object.getOwnPropertyNames(value).flatMap((name) => {
    let property: unknown;
    try {
      property = (value as Record<string, unknown>)[name];
    } catch {
      return [name];
    }
    return [name, ...heldStrings(property, depth - 1, seen)];
  });
}

afterEach(async () => {
  cleanup();
  window.history.replaceState(null, "");
  await loadDocument(undefined);
});

/**
 * Exports with "version" in the name that are about something else.
 * `setBuildVersions` installs the cache versions of a simulated build for the
 * server-side testing primitives (testing/build-versions.ts): it takes
 * versions and returns nothing, and a client still learns the version it
 * records location state under only from the payload it loads.
 */
const OTHER_VERSIONS: ReadonlySet<string> = new Set(["setBuildVersions"]);

describe("the version of location state is not public", () => {
  it.each(Object.keys(ENTRIES))("%s exports nothing named after it", (name) => {
    expect(
      Object.keys(ENTRIES[name]!).filter(
        (key) => /version/i.test(key) && !OTHER_VERSIONS.has(key),
      ),
    ).toEqual([]);
  });

  it("no export, definition, entry or hook result holds the running version", async () => {
    const { createLocationState, useLocationState } = clientEntry;
    const GridState = testingEntry.withLocationStateKey(
      createLocationState<{ count: number }>(),
      "SurfaceGrid",
    );
    await loadDocument(SENTINEL);
    mergeLocationState({ [GridState.__rsc_ls_key]: { count: 3 } });
    // The premise: the client runs SENTINEL and recorded it on the entry, and
    // the walk below would see it on an export.
    expect(JSON.stringify(window.history.state)).toContain(SENTINEL);
    const exposing = {
      api: {
        get current() {
          return SENTINEL;
        },
      },
    };
    expect(heldStrings(exposing, 4, new Set())).toContain(SENTINEL);

    for (const [name, entry] of Object.entries(ENTRIES)) {
      expect(
        heldStrings(entry, 4, new Set()).filter((held) =>
          held.includes(SENTINEL),
        ),
        name,
      ).toEqual([]);
    }

    expect(Object.getOwnPropertyNames(GridState).sort()).toEqual(
      [
        "__rsc_ls_flash",
        "__rsc_ls_key",
        "delete",
        "length",
        "name",
        "read",
        "write",
      ].sort(),
    );
    expect(GridState({ count: 1 })).toStrictEqual({
      __rsc_ls_key: "__rsc_ls_SurfaceGrid",
      __rsc_ls_value: { count: 1 },
    });
    expect(GridState.read()).toStrictEqual({ count: 3 });

    let typed: unknown;
    let plain: unknown = "unset";
    function Reader(): null {
      typed = useLocationState(GridState);
      plain = useLocationState();
      return null;
    }
    await act(async () => {
      render(<Reader />);
    });
    expect(typed).toStrictEqual({ count: 3 });
    expect(plain).toBeUndefined();
  });
});
