// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createLocationState, useLocationState } from "../../client.js";
import {
  initBrowserApp,
  resetBrowserAppContext,
  type BrowserAppContext,
} from "../../browser/rsc-router.js";
import { NavigationProvider } from "../../browser/react/NavigationProvider.js";
import {
  buildHistoryState,
  mergeLocationState,
} from "../../browser/history-state.js";
import type {
  RscBrowserDependencies,
  RscPayload,
} from "../../browser/types.js";
import { renderRoute } from "../dom.entry.js";
import { withLocationStateKey } from "../index.js";

// The implicit version of location state, as readers see it: the hook for a
// typed definition, a flash definition and plain state, and renderRoute. The
// client's version arrives with the document payload (initBrowserApp), as in
// production; a renderRoute tree has none.
//
// Readers take the entry's state from the document's NavigationProvider
// (#1029), which holds what the event controller last committed: `commitEntry`
// does what a commit site without a payload does.

let app: BrowserAppContext;

const GridState = withLocationStateKey(
  createLocationState<{ count: number }>(),
  "VersionGrid",
);
const FlashState = withLocationStateKey(
  createLocationState<{ count: number }>({ flash: true }),
  "VersionFlash",
);

/** A document load of the current entry under `version`. */
async function loadDocument(
  version: string | undefined,
): Promise<BrowserAppContext> {
  resetBrowserAppContext();
  const payload = {
    metadata: { version, pathname: "/", segments: [], matched: [], params: {} },
  } as unknown as RscPayload;
  app = await initBrowserApp({
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
  return app;
}

async function commitEntry(
  eventController: BrowserAppContext["eventController"],
  write: () => void,
): Promise<void> {
  await act(async () => {
    write();
    eventController.commitLocationState(window.history.state, true);
    eventController.flushRouteState();
  });
}

/**
 * The state of an entry a client running `version` wrote: plain state from a
 * navigation, a typed slot and a flash slot from the server.
 */
async function entryWrittenUnder(
  version: string,
  count: number,
): Promise<unknown> {
  await loadDocument(version);
  window.history.replaceState(
    buildHistoryState({ from: `plain-${count}` }),
    "",
  );
  mergeLocationState({
    [GridState.__rsc_ls_key]: { count },
    [FlashState.__rsc_ls_key]: { count },
  });
  // The navigation and the server merge that wrote it committed it.
  app.eventController.commitLocationState(window.history.state);
  return window.history.state;
}

function Readers(): ReactNode {
  const grid = useLocationState(GridState);
  const flash = useLocationState(FlashState);
  const plain = useLocationState<{ from?: string }>();
  return (
    <p data-testid="readers">
      {`${grid?.count ?? "none"}|${flash?.count ?? "none"}|${plain?.from ?? "none"}`}
    </p>
  );
}
const SERVER_HTML = '<p data-testid="readers">none|none|none</p>';

let root: Root | undefined;

async function hydrateReaders(): Promise<{
  text: () => string | null;
  recoverable: string[];
}> {
  const container = document.createElement("div");
  container.innerHTML = SERVER_HTML;
  document.body.appendChild(container);
  const recoverable: string[] = [];
  await act(async () => {
    const routed = (
      <NavigationProvider
        store={app.store}
        eventController={app.eventController}
        bridge={app.bridge}
        initialPayload={{
          root: <Readers />,
          metadata: app.initialPayload.metadata!,
        }}
        hydration={{ settled: app.documentRevealed }}
      />
    );
    root = hydrateRoot(container, routed, {
      onRecoverableError(error: unknown) {
        recoverable.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  });
  await act(async () => {});
  return { text: () => container.textContent, recoverable };
}

afterEach(async () => {
  if (root) {
    const current = root;
    root = undefined;
    await act(async () => current.unmount());
  }
  cleanup();
  document.body.replaceChildren();
  window.history.replaceState(null, "");
  await loadDocument(undefined);
});

describe("useLocationState under the implicit version", () => {
  it("after a document load under the same version every reader shows its state", async () => {
    await entryWrittenUnder("build-1", 3);
    await loadDocument("build-1");

    const { text, recoverable } = await hydrateReaders();
    expect(recoverable).toEqual([]);
    expect(text()).toBe("3|3|plain-3");
  });

  it("after a document load under another version typed, flash and plain state all read as none", async () => {
    const written = await entryWrittenUnder("build-1", 3);
    await loadDocument("build-2");

    const { text, recoverable } = await hydrateReaders();
    expect(recoverable).toEqual([]);
    expect(text()).toBe("none|none|none");
    // Nothing was read, so the flash slot was not consumed either.
    expect(window.history.state).toMatchObject(written as object);
  });

  it("back/forward to an entry another version wrote reads none; to a current one, its state", async () => {
    const older = await entryWrittenUnder("build-1", 1);
    const current = await entryWrittenUnder("build-2", 2);
    const { text } = await hydrateReaders();
    expect(text()).toBe("2|2|plain-2");

    await commitEntry(app.eventController, () =>
      window.history.replaceState(older, ""),
    );
    expect(text()).toBe("none|none|none");

    await commitEntry(app.eventController, () =>
      window.history.replaceState(
        { ...(current as object), [FlashState.__rsc_ls_key]: { count: 2 } },
        "",
      ),
    );
    expect(text()).toBe("2|2|plain-2");
  });

  it("a flash written under the current version into an older entry is shown once, without the older state", async () => {
    await entryWrittenUnder("build-1", 1);
    await loadDocument("build-2");
    const { text } = await hydrateReaders();
    expect(text()).toBe("none|none|none");

    await commitEntry(app.eventController, () =>
      mergeLocationState({ [FlashState.__rsc_ls_key]: { count: 9 } }),
    );
    expect(text()).toBe("none|9|none");
    expect(window.history.state).not.toHaveProperty(FlashState.__rsc_ls_key);
    expect(window.history.state).not.toHaveProperty(GridState.__rsc_ls_key);
    expect(window.history.state).not.toHaveProperty("state");
  });

  it("a dev HMR version bump keeps what the readers show", async () => {
    const entry = await entryWrittenUnder("dev-1", 4);
    const { bridge, eventController } = await loadDocument("dev-1");
    const { text } = await hydrateReaders();
    expect(text()).toBe("4|4|plain-4");

    await commitEntry(eventController, () => {
      bridge.updateVersion("dev-2");
      window.history.replaceState(entry, "");
    });
    expect(text()).toBe("4|4|plain-4");
  });
});

describe("renderRoute under the implicit version", () => {
  const routes = [{ path: "/grid", Component: Readers }];
  const seeds = [[GridState, { count: 5 }]] as const;

  it("a seed is readable, hydrated or not, whatever version an earlier document left", async () => {
    await loadDocument("build-1");

    const mounted = await renderRoute(routes, { locationState: seeds });
    expect(mounted.getByTestId("readers").textContent).toBe("5|none|none");
    expect(window.history.state).toEqual({
      [GridState.__rsc_ls_key]: { count: 5 },
    });
    mounted.unmount();

    const hydrated = await renderRoute(routes, {
      hydrate: true,
      locationState: seeds,
    });
    expect(hydrated.serverHtml).toContain("none|none|none");
    expect(hydrated.recoverableErrors).toEqual([]);
    expect(hydrated.getByTestId("readers").textContent).toBe("5|none|none");
  });

  it("an entry a versioned client wrote is not read by the tree", async () => {
    const written = await entryWrittenUnder("build-1", 3);
    const { getByTestId, recoverableErrors } = await renderRoute(routes, {
      hydrate: true,
      locationState: seeds,
    });
    expect(getByTestId("readers").textContent).toBe("5|none|none");

    // Back/forward onto it, the way a consumer test models one.
    await act(async () => {
      window.history.replaceState(written, "");
      window.dispatchEvent(new Event("popstate"));
    });
    expect(getByTestId("readers").textContent).toBe("none|none|none");
    expect(recoverableErrors).toEqual([]);
  });
});
