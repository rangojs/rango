// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  initBrowserApp,
  resetBrowserAppContext,
} from "../browser/rsc-router.js";
import { createLocationState } from "../browser/react/location-state-shared.js";
import { mergeLocationState } from "../browser/history-state.js";
import { withLocationStateKey } from "../testing/location-state-key.js";
import type { RscBrowserDependencies, RscPayload } from "../browser/types.js";

// The order initBrowserApp guarantees for `clearOnReload`: the stale slot is
// gone before the document's Flight payload is decoded, which is before any
// reader hydrates and before a navigation or action payload can deliver
// server-set state. State the server sets afterwards is therefore kept.

const Carried = withLocationStateKey(
  createLocationState<string[]>({ clearOnReload: true }),
  "InitCarried",
);
const Persistent = withLocationStateKey(
  createLocationState<{ order: string }>(),
  "InitPersistent",
);

afterEach(() => {
  resetBrowserAppContext();
  window.history.replaceState(null, "");
});

function documentPayload(): RscPayload {
  return {
    metadata: { pathname: "/", segments: [], matched: [], params: {} },
  } as unknown as RscPayload;
}

function depsDecoding(
  onDecode: () => void,
  payload: RscPayload,
): RscBrowserDependencies {
  return {
    createFromReadableStream: async () => {
      onDecode();
      return payload;
    },
    createFromFetch: async () => payload,
    setServerCallback: () => {},
    encodeReply: async () => "",
    createTemporaryReferenceSet: () => ({}),
  } as unknown as RscBrowserDependencies;
}

describe("initBrowserApp: clearOnReload location state", () => {
  it("drops the entry's clearOnReload slots before the payload is decoded and keeps the rest", async () => {
    window.history.replaceState(
      {
        [Carried.__rsc_ls_key]: Carried(["p4", "p5"]).__rsc_ls_value,
        [Persistent.__rsc_ls_key]: { order: "asc" },
        idx: 3,
      },
      "",
    );
    const atDecode: unknown[] = [];

    await initBrowserApp({
      rscStream: new ReadableStream<Uint8Array>(),
      deps: depsDecoding(
        () => atDecode.push(window.history.state),
        documentPayload(),
      ),
      linkInterception: false,
    });

    const kept = { [Persistent.__rsc_ls_key]: { order: "asc" }, idx: 3 };
    expect(atDecode).toEqual([kept]);
    // The store stamps its entry key later; the slot stays gone.
    expect(window.history.state).toMatchObject(kept);
    expect(window.history.state).not.toHaveProperty(Carried.__rsc_ls_key);
    expect(Carried.read()).toBeUndefined();
  });

  it("state the server sets after start-up is not dropped", async () => {
    window.history.replaceState(
      { [Carried.__rsc_ls_key]: Carried(["stale"]).__rsc_ls_value },
      "",
    );
    await initBrowserApp({
      rscStream: new ReadableStream<Uint8Array>(),
      deps: depsDecoding(() => {}, documentPayload()),
      linkInterception: false,
    });
    expect(Carried.read()).toBeUndefined();

    // What an action or navigation payload's metadata.locationState does.
    mergeLocationState({
      [Carried.__rsc_ls_key]: Carried(["fresh"]).__rsc_ls_value,
    });
    expect(Carried.read()).toEqual(["fresh"]);
  });

  it("does not rewrite history.state when no slot is marked", async () => {
    const state = { [Persistent.__rsc_ls_key]: { order: "asc" }, idx: 1 };
    window.history.replaceState(state, "");
    const before = window.history.state;
    const atDecode: unknown[] = [];

    await initBrowserApp({
      rscStream: new ReadableStream<Uint8Array>(),
      deps: depsDecoding(
        () => atDecode.push(window.history.state),
        documentPayload(),
      ),
      linkInterception: false,
    });

    // Same object: no replaceState ran before the decode.
    expect(atDecode[0]).toBe(before);
    expect(atDecode[0]).toEqual(state);
    expect(window.history.state).toMatchObject(state);
  });
});
