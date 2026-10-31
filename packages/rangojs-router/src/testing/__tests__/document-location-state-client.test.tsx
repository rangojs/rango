// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { createLocationState, useLocationState } from "../../client.js";
import {
  initBrowserApp,
  resetBrowserAppContext,
} from "../../browser/rsc-router.js";
import type {
  RscBrowserDependencies,
  RscPayload,
} from "../../browser/types.js";
import { setLocationStateVersion } from "../../browser/react/location-state-shared.js";
import { renderRoute } from "../dom.entry.js";
import { withLocationStateKey } from "../index.js";

// #1330: the location state a document response carries (its bootstrap
// payload's metadata.locationState) is merged into the entry the document
// loaded on, after start-up's clearOnReload pass, and reaches a reader once
// it has hydrated, as stored state does. Through initBrowserApp itself and
// through the public renderRoute({ hydrate, documentLocationState }).

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>({ flash: true }),
  "DocFlash",
);
const Carried = withLocationStateKey(
  createLocationState<{ page: number }>({ clearOnReload: true }),
  "DocCarried",
);

async function loadDocument(
  locationState: Record<string, unknown> | undefined,
): Promise<void> {
  resetBrowserAppContext();
  const payload = {
    metadata: {
      pathname: "/",
      segments: [],
      matched: [],
      params: {},
      version: "v1",
      ...(locationState && { locationState }),
    },
  } as unknown as RscPayload;
  await initBrowserApp({
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

afterEach(() => {
  cleanup();
  resetBrowserAppContext();
  setLocationStateVersion(undefined);
  window.history.replaceState(null, "");
});

describe("a document response's location state at start-up (#1330)", () => {
  it("is merged into the entry under the document's version, keeping router bookkeeping", async () => {
    window.history.replaceState({ idx: 4 }, "");

    await loadDocument({ [Flash.__rsc_ls_key]: { text: "paid" } });

    expect(window.history.state).toMatchObject({
      idx: 4,
      __rsc_lsv: "v1",
      [Flash.__rsc_ls_key]: { text: "paid" },
    });
    expect(Flash.read()).toEqual({ text: "paid" });
  });

  it("keeps a clearOnReload slot the server set for this load, and drops the stored one", async () => {
    window.history.replaceState(
      { __rsc_lsv: "v1", [Carried.__rsc_ls_key]: { page: 1 } },
      "",
    );

    await loadDocument({ [Carried.__rsc_ls_key]: { page: 2 } });
    expect(Carried.read()).toEqual({ page: 2 });

    // The next document load (a refresh) carries none: the slot goes.
    await loadDocument(undefined);
    expect(Carried.read()).toBeUndefined();
  });

  it("takes only typed slots", async () => {
    window.history.replaceState(null, "");

    await loadDocument({ idx: 9, state: { plain: true } });

    const state = (window.history.state ?? {}) as Record<string, unknown>;
    expect(state.idx).toBeUndefined();
    expect(state.state).toBeUndefined();
    expect(state.__rsc_lsv).toBeUndefined();
  });
});

describe("renderRoute: documentLocationState (#1330)", () => {
  it("a reader hydrates as undefined, then shows the document's state", async () => {
    const seen: Array<string | undefined> = [];
    function Banner() {
      const flash = useLocationState(Flash);
      seen.push(flash?.text);
      return <p data-testid="flash">{flash?.text ?? "none"}</p>;
    }

    const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
      [{ path: "/", Component: Banner }],
      {
        hydrate: true,
        documentLocationState: [[Flash, { text: "Payment declined" }]],
      },
    );

    expect(serverHtml).toContain('<p data-testid="flash">none</p>');
    expect(recoverableErrors).toEqual([]);
    expect(seen[0]).toBeUndefined();
    expect(getByTestId("flash").textContent).toBe("Payment declined");
  });

  it("applies a clearOnReload slot the document carries after the hydrate pass removed the stored one", async () => {
    function Page() {
      const carried = useLocationState(Carried);
      return <p data-testid="page">{carried?.page ?? 0}</p>;
    }

    const { getByTestId } = await renderRoute(
      [{ path: "/", Component: Page }],
      {
        hydrate: true,
        locationState: [[Carried, { page: 1 }]],
        documentLocationState: [[Carried, { page: 2 }]],
      },
    );

    expect(getByTestId("page").textContent).toBe("2");
  });
});
