// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHandle } from "../handle.js";
import {
  createEventController,
  type EventController,
} from "../browser/event-controller.js";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "../browser/react/context.js";
import { useHandle } from "../browser/react/use-handle.js";

// Issue #1035: a render React is hydrating reads the handle state the
// document's HTML was rendered with, whenever its boundary hydrates. The
// late handle channel (rsc-router.tsx) is released when the ROOT hydrates,
// so a boundary that hydrates after it used to read values its HTML did not
// have. A hydrateRoot call made after the late update was applied is that
// late hydration render. The server HTML is hand-written to isolate the
// hook; the same contract through the public primitive
// (renderRoute({ hydrate: true, lateHandles })) is in
// testing/__tests__/render-route-hydrate.test.tsx.

const Notes = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_hydration_notes__",
);

const MATCHED = ["R0"];
const DOCUMENT = { [Notes.$$id]: { R0: ["document"] } };
const LATE = { [Notes.$$id]: { R0: ["document", "late"] } };

let root: Root | undefined;
let controller: EventController;
let renders: string[][];

beforeEach(() => {
  renders = [];
  controller = createEventController({
    initialLocation: new URL("http://localhost/"),
  });
  // initBrowserApp: the document's snapshot, frozen before hydrateRoot.
  controller.setHandleData(DOCUMENT, MATCHED);
  controller.freezeHydrationHandleState();
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = undefined;
    await act(async () => current.unmount());
  }
  document.body.replaceChildren();
});

function Rows(): ReactNode {
  const notes = useHandle(Notes);
  renders.push(notes);
  return (
    <ul>
      {notes.map((note, index) => (
        <li key={index}>{note}</li>
      ))}
    </ul>
  );
}

function Count(): ReactNode {
  const count = useHandle(Notes, (notes) => notes.length);
  return <p>{count}</p>;
}

function tree(node: ReactNode): ReactNode {
  const value = {
    eventController: controller,
  } as NavigationStoreContextValue;
  return (
    <NavigationStoreContext.Provider value={value}>
      {node}
    </NavigationStoreContext.Provider>
  );
}

async function hydrate(
  node: ReactNode,
  serverHtml: string,
): Promise<{ container: HTMLDivElement; recoverable: string[] }> {
  const container = document.createElement("div");
  container.innerHTML = serverHtml;
  document.body.appendChild(container);
  const recoverable: string[] = [];
  await act(async () => {
    root = hydrateRoot(container, tree(node), {
      onRecoverableError(error: unknown) {
        recoverable.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  });
  return { container, recoverable };
}

/** The late channel's update, applied the way rsc-router.tsx applies it. */
function applyLate(): void {
  controller.setHandleData(LATE, MATCHED);
  controller.flushRouteState();
}

describe("useHandle: a hydrating render reads the document's handle state", () => {
  it("a reader that hydrates after a late update hydrates with the document's values, then shows the update", async () => {
    applyLate();

    const { container, recoverable } = await hydrate(
      <Rows />,
      "<ul><li>document</li></ul>",
    );

    expect(recoverable).toEqual([]);
    // The hydrating render, then one render on the live state.
    expect(renders).toEqual([["document"], ["document", "late"]]);
    expect(container.innerHTML).toBe("<ul><li>document</li><li>late</li></ul>");
  });

  it("applies the selector to the document's values on that render", async () => {
    applyLate();

    const { container, recoverable } = await hydrate(<Count />, "<p>1</p>");

    expect(recoverable).toEqual([]);
    expect(container.innerHTML).toBe("<p>2</p>");
  });

  it("a reader that hydrates with nothing late renders once", async () => {
    const { container, recoverable } = await hydrate(
      <Rows />,
      "<ul><li>document</li></ul>",
    );

    expect(recoverable).toEqual([]);
    expect(renders).toEqual([["document"]]);
    expect(container.innerHTML).toBe("<ul><li>document</li></ul>");
  });

  it("a reader that hydrated before the late update gets it through its subscription, with no extra render", async () => {
    const { container } = await hydrate(<Rows />, "<ul><li>document</li></ul>");

    await act(async () => applyLate());

    // The update's optimistic pass and its transition, as without a freeze.
    expect(renders).toEqual([
      ["document"],
      ["document", "late"],
      ["document", "late"],
    ]);
    expect(container.innerHTML).toBe("<ul><li>document</li><li>late</li></ul>");
  });

  it("a reader that mounts after the late update reads the live state", async () => {
    applyLate();
    const container = document.body.appendChild(document.createElement("div"));

    await act(async () => {
      root = createRoot(container);
      root.render(tree(<Rows />));
    });

    expect(renders).toEqual([["document", "late"]]);
    expect(container.innerHTML).toBe("<ul><li>document</li><li>late</li></ul>");
  });
});
