// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEventController,
  type EventController,
} from "../browser/event-controller.js";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "../browser/react/context.js";
import { useAction } from "../browser/react/use-action.js";
import {
  LinkContext,
  useLinkStatus,
} from "../browser/react/use-link-status.js";
import { useNavigation } from "../browser/react/use-navigation.js";
import { useParams } from "../browser/react/use-params.js";
import { usePathname } from "../browser/react/use-pathname.js";
import { useSearchParams } from "../browser/react/use-search-params.js";
import { useSegments } from "../browser/react/use-segments.js";

// A component that hydrates while the hydration window is open (a boundary
// that streamed in after the root) renders what SSR rendered, even when a
// navigation or an action has moved the live state on: the first render of
// every router hook reads EventController.getHydrationSnapshot(). Its effect
// then catches up with the live state. A hydrateRoot call made after the
// live state moved is that late hydration render. The server HTML is
// hand-written to isolate the hooks.

const DOCUMENT = "/items/7|7|a|idle|idle|items/7";
const LIVE = "/items/8|8|b|loading|loading|items/8";

let root: Root | undefined;
let controller: EventController;
let renders: string[];

beforeEach(() => {
  renders = [];
  controller = createEventController({
    initialLocation: new URL("http://localhost/items/7?tab=a"),
  });
  // initBrowserApp: the document's params and handles, then the lock,
  // before hydrateRoot.
  controller.setParams({ id: "7" });
  controller.setHandleData({}, ["R0"]);
  controller.lockHydration();
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = undefined;
    await act(async () => current.unmount());
  }
  document.body.replaceChildren();
});

function Readers(): ReactNode {
  const pathname = usePathname();
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const state = useNavigation((nav) => nav.state);
  const action = useAction("saveItem", (tracked) => tracked.state);
  const path = useSegments((segments) => segments.path.join("/"));
  const text = [pathname, id, search.get("tab"), state, action, path].join("|");
  renders.push(text);
  return <p>{text}</p>;
}

function Pending(): ReactNode {
  return <i>{useLinkStatus().pending ? "pending" : "settled"}</i>;
}

function tree(): ReactNode {
  const value = {
    eventController: controller,
    origin: "http://localhost",
  } as NavigationStoreContextValue;
  return (
    <NavigationStoreContext.Provider value={value}>
      <Readers />
      <LinkContext.Provider value="/items/8?tab=b">
        <Pending />
      </LinkContext.Provider>
    </NavigationStoreContext.Provider>
  );
}

async function hydrate(
  serverHtml: string,
): Promise<{ container: HTMLDivElement; recoverable: string[] }> {
  const container = document.createElement("div");
  container.innerHTML = serverHtml;
  document.body.appendChild(container);
  const recoverable: string[] = [];
  await act(async () => {
    root = hydrateRoot(container, tree(), {
      onRecoverableError(error: unknown) {
        recoverable.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  });
  return { container, recoverable };
}

/** A navigation that has started streaming, and an action in flight. */
function moveLiveState(): void {
  controller.startNavigation("/items/8?tab=b");
  controller.setLocation(new URL("http://localhost/items/8?tab=b"));
  controller.setParams({ id: "8" });
  controller.startAction("src/actions.ts#saveItem", []);
}

describe("router hooks: a hydrating render reads the document's state", () => {
  it("a component that hydrates after the live state moved hydrates with the document's state, then shows the live state", async () => {
    moveLiveState();
    expect(controller.getActionState("saveItem").state).toBe("loading");

    const { container, recoverable } = await hydrate(
      `<p>${DOCUMENT}</p><i>settled</i>`,
    );

    expect(recoverable).toEqual([]);
    expect(renders[0]).toBe(DOCUMENT);
    expect(renders.at(-1)).toBe(LIVE);
    expect(container.innerHTML).toBe(`<p>${LIVE}</p><i>pending</i>`);
  });

  it("a component that hydrates with nothing moved renders once", async () => {
    const { container, recoverable } = await hydrate(
      `<p>${DOCUMENT}</p><i>settled</i>`,
    );

    expect(recoverable).toEqual([]);
    expect(renders).toEqual([DOCUMENT]);
    expect(container.innerHTML).toBe(`<p>${DOCUMENT}</p><i>settled</i>`);
  });

  it("after the window closes, a first render reads the live state", async () => {
    controller.releaseHydrationLock();
    moveLiveState();
    const container = document.body.appendChild(document.createElement("div"));

    await act(async () => {
      root = createRoot(container);
      root.render(tree());
    });

    expect(renders[0]).toBe(LIVE);
    expect(container.innerHTML).toBe(`<p>${LIVE}</p><i>pending</i>`);
  });
});
