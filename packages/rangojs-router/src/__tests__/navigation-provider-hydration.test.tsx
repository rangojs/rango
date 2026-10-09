// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHandle } from "../handle.js";
import {
  initBrowserApp,
  resetBrowserAppContext,
  type BrowserAppContext,
} from "../browser/rsc-router.js";
import { NavigationProvider } from "../browser/react/NavigationProvider.js";
import { commitInTransition } from "../browser/partial-update.js";
import { useHandle } from "../browser/react/use-handle.js";
import { usePathname } from "../browser/react/use-pathname.js";
import type { RscBrowserDependencies, RscPayload } from "../browser/types.js";

// A navigation that commits while the document is still streaming (its
// boundaries not all revealed, so the hydration window is open) must mount
// its page against the live store: NavigationProvider releases the store
// before that update. Released after the commit instead, the page's first
// render read the document's pathname and handles.

const Notes = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_provider_hydration_notes__",
);

let app: BrowserAppContext;
let root: Root | undefined;
let renders: { pathname: string; notes: string[] }[];

beforeEach(async () => {
  renders = [];
  resetBrowserAppContext();
  const payload = {
    metadata: { pathname: "/", segments: [], matched: [], params: {} },
  } as unknown as RscPayload;
  // Locks the store for the hydration window, as before hydrateRoot.
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
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = undefined;
    await act(async () => current.unmount());
  }
  cleanup();
  document.body.replaceChildren();
  resetBrowserAppContext();
});

function Destination(): ReactNode {
  const pathname = usePathname();
  const notes = useHandle(Notes);
  renders.push({ pathname, notes });
  return <p>{pathname}</p>;
}

describe("NavigationProvider: a navigation committed during the hydration window", () => {
  it("mounts its page against the live store, from the first render", async () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>document</p>";
    document.body.appendChild(container);
    await act(async () => {
      root = hydrateRoot(
        container,
        <NavigationProvider
          store={app.store}
          eventController={app.eventController}
          bridge={app.bridge}
          initialPayload={{
            root: <p>document</p>,
            metadata: app.initialPayload.metadata!,
          }}
          // A document never revealed: the window stays open.
          hydration={{ settled: new Promise<void>(() => {}) }}
        />,
      );
    });

    // What a navigation commit does (navigation-bridge.ts): the location,
    // then the payload update in a transition, its handles with it.
    await act(async () => {
      app.eventController.setLocation(new URL("http://localhost/next"));
      commitInTransition(
        app.store.loaders,
        (update) => app.store.emitUpdate(update),
        [],
        {
          root: <Destination />,
          metadata: {
            ...app.initialPayload.metadata!,
            pathname: "/next",
            matched: ["R1"],
            cachedHandleData: { [Notes.$$id]: { R1: ["next"] } },
          },
        },
        ["navigation"],
      );
    });

    expect(renders[0]).toEqual({ pathname: "/next", notes: ["next"] });
    expect(renders.at(-1)).toEqual({ pathname: "/next", notes: ["next"] });
    expect(container.textContent).toBe("/next");
    expect(app.eventController.getHydrationSnapshot()).toBeUndefined();
  });
});
