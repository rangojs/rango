// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import {
  Profiler,
  Suspense,
  useState,
  ViewTransition,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  createEventController,
  type EventController,
} from "../browser/event-controller.js";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "../browser/react/context.js";
import { usePathname } from "../browser/react/use-pathname.js";
import { createNavigationBridge } from "../browser/navigation-bridge.js";
import { commitInTransition } from "../browser/partial-update.js";
import { LoaderStore } from "../loader-store.js";
import type { NavigationUpdate, ResolvedSegment } from "../browser/types.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

vi.mock("../browser/scroll-restoration.js", () => ({
  handleNavigationStart: vi.fn(),
  handleNavigationEnd: vi.fn(),
  handleTraversalStart: vi.fn(),
  ensureHistoryKey: vi.fn(),
  getHistoryStateKey: vi.fn(() => "k"),
}));

/**
 * A back/forward restored from the history cache (navigation-bridge.ts
 * handlePopstate). React commits a transition started while window.event is
 * the popstate event synchronously, with no view transition, and leaves its
 * types queued for the next transition commit (react-dom
 * shouldAttemptEagerTransition). Under transition() the bridge commits the
 * restore on the next task, tagged pop and navigation-back. A swipe the
 * browser animated (hasUAVisualTransition), an entry whose scroll the browser
 * restores itself (history.scrollRestoration "auto") and a route without
 * transition() commit inside the event and add no type.
 *
 * Real React, the happy-dom view-transition stub, and a window.event getter
 * that holds the popstate event for its task, as a browser does. A
 * <Profiler> logs what each commit shows: "<usePathname>|<page>".
 */

const ORIGIN = "http://localhost";

let controller: EventController;
let root: Root | undefined;
let stub: ReturnType<typeof installViewTransitionStub>;
let setTree!: (tree: ReactNode) => void;
let windowEvent: Event | undefined;
let log: string[];
let updates: { page: string; inEvent: boolean }[];

const text = (id: string): string =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

function Page({ id }: { id: string }): ReactNode {
  return <p data-testid="page">{id}</p>;
}

function Pathname(): ReactNode {
  return <p data-testid="pathname">{usePathname()}</p>;
}

function Shell(): ReactNode {
  const [tree, set] = useState<ReactNode>(<Page id="c" />);
  setTree = set;
  return (
    <Profiler
      id="app"
      onRender={() => log.push(`${text("pathname")}|${text("page")}`)}
    >
      <Pathname />
      <ViewTransition>
        <Suspense fallback={null}>{tree}</Suspense>
      </ViewTransition>
    </Profiler>
  );
}

function segment(id: string, transition: boolean): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type: "route",
    component: null,
    ...(transition ? { transition: {} } : {}),
  } as unknown as ResolvedSegment;
}

/** A bridge whose history cache holds every entry; `transition()` or not. */
let historyKey: string;

function bridgeFor(transition: boolean) {
  historyKey = "/c";
  const store = {
    getHistoryKey: vi.fn(() => historyKey),
    setHistoryKey: vi.fn((key: string) => (historyKey = key)),
    setSegmentIds: vi.fn(),
    setCurrentUrl: vi.fn(),
    setPath: vi.fn(),
    getSegmentState: vi.fn(() => ({
      path: "/c",
      currentUrl: `${ORIGIN}/c`,
      currentSegmentIds: ["c"],
    })),
    getCachedSegments: vi.fn((key: string) => ({
      segments: [segment(key.slice(1), transition)],
      stale: false,
    })),
    getHistoryEntryMemory: vi.fn(() => undefined),
    rememberDisplayedEntry: vi.fn(),
    getInterceptSourceUrl: vi.fn(() => null),
    setInterceptSourceUrl: vi.fn(),
  };
  return createNavigationBridge({
    store: store as any,
    client: {} as any,
    eventController: controller,
    onUpdate: (update: NavigationUpdate) => {
      updates.push({
        page: (update.root as { props: { id: string } }).props.id,
        inEvent: windowEvent !== undefined,
      });
      setTree(update.root as ReactNode);
      controller.flushRouteState("release");
    },
    renderSegments: vi.fn(async (segments: ResolvedSegment[]) => (
      <Page id={segments[0]!.id} />
    )) as any,
  });
}

/**
 * The browser's popstate for `path`: history moves, then the event's task
 * runs the listener with window.event set, and its microtasks.
 */
function popstateEvent(path: string, uaVisual = false): PopStateEvent {
  window.history.replaceState({ key: path }, "", path);
  const event = new PopStateEvent("popstate", { state: window.history.state });
  if (uaVisual) {
    Object.defineProperty(event, "hasUAVisualTransition", { value: true });
  }
  windowEvent = event;
  // The event's task ends: timers scheduled from here on run after it.
  setTimeout(() => (windowEvent = undefined), 0);
  return event;
}

/** The commit after the Back: a link click under transition(). */
function forwardClick(): void {
  commitInTransition(
    new LoaderStore(),
    (update) => setTree(update.root as ReactNode),
    [],
    { root: <Page id="next" />, metadata: {} } as unknown as NavigationUpdate,
    "push",
    ["navigation"],
  );
}

beforeEach(() => {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  env.IS_REACT_ACT_ENVIRONMENT = false;
  log = [];
  updates = [];
  windowEvent = undefined;
  Object.defineProperty(window, "event", {
    get: () => windowEvent,
    configurable: true,
  });
  window.history.replaceState({ key: "/c" }, "", "/c");
  // <Html.ScrollRestoration> owns scroll.
  window.history.scrollRestoration = "manual";
  controller = createEventController({
    initialLocation: new URL("/c", ORIGIN),
  });
  stub = installViewTransitionStub();
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const value = {
    eventController: controller,
    origin: ORIGIN,
  } as NavigationStoreContextValue;
  flushSync(() =>
    root!.render(
      <NavigationStoreContext.Provider value={value}>
        <Shell />
      </NavigationStoreContext.Provider>,
    ),
  );
});

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  stub.uninstall();
  window.history.scrollRestoration = "auto";
  delete (window as { event?: unknown }).event;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("handlePopstate: a back/forward restored from the history cache", () => {
  it("transition(): commits on the next task, in a view transition tagged pop and navigation-back", async () => {
    const bridge = bridgeFor(true);

    await bridge.handlePopstate(popstateEvent("/b"));
    expect(updates).toEqual([]);

    await waitFor(() => expect(text("page")).toBe("b"));
    expect(updates).toEqual([{ page: "b", inEvent: false }]);
    expect(stub.types()).toEqual([["pop", "navigation-back"]]);
    // usePathname takes /b with the restored tree, never over the page left.
    expect(log).not.toContain("/b|c");
    expect(text("pathname")).toBe("/b");
  });

  it("transition(): a later back/forward supersedes a restore not yet committed", async () => {
    const bridge = bridgeFor(true);

    const first = bridge.handlePopstate(popstateEvent("/b"));
    const second = bridge.handlePopstate(popstateEvent("/a"));
    await Promise.all([first, second]);

    await waitFor(() => expect(text("page")).toBe("a"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updates).toEqual([{ page: "a", inEvent: false }]);
    expect(stub.types()).toEqual([["pop", "navigation-back"]]);
  });

  it("transition(): a navigation that commits before the restore's task keeps the screen", async () => {
    const bridge = bridgeFor(true);

    await bridge.handlePopstate(popstateEvent("/b"));
    // A shallow navigation (revalidate: false) commits in the same task, from
    // an app's own popstate listener: the store moves to its entry.
    historyKey = "/shallow";
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(updates).toEqual([]);
    expect(text("page")).toBe("c");
    expect(stub.types()).toEqual([]);
  });

  it("transition(): the click after the Back carries its own types only", async () => {
    const bridge = bridgeFor(true);
    await bridge.handlePopstate(popstateEvent("/b"));
    await waitFor(() => expect(text("page")).toBe("b"));

    forwardClick();
    await waitFor(() => expect(text("page")).toBe("next"));
    expect(stub.types()).toEqual([
      ["pop", "navigation-back"],
      ["push", "navigation"],
    ]);
  });

  it("a swipe the browser animated (hasUAVisualTransition) commits in the event, with no view transition and no type", async () => {
    const bridge = bridgeFor(true);

    await bridge.handlePopstate(popstateEvent("/b", true));
    expect(updates).toEqual([{ page: "b", inEvent: true }]);
    await waitFor(() => expect(text("page")).toBe("b"));

    forwardClick();
    await waitFor(() => expect(text("page")).toBe("next"));
    expect(stub.types()).toEqual([["push", "navigation"]]);
  });

  it("an entry whose scroll the browser restores (scrollRestoration auto) commits in the event, so that restore sees the restored page", async () => {
    window.history.scrollRestoration = "auto";
    const bridge = bridgeFor(true);

    await bridge.handlePopstate(popstateEvent("/b"));
    expect(updates).toEqual([{ page: "b", inEvent: true }]);
    await waitFor(() => expect(text("page")).toBe("b"));

    forwardClick();
    await waitFor(() => expect(text("page")).toBe("next"));
    expect(stub.types()).toEqual([["push", "navigation"]]);
  });

  it("no transition(): commits in the event and queues no type", async () => {
    const bridge = bridgeFor(false);

    await bridge.handlePopstate(popstateEvent("/b"));
    expect(updates).toEqual([{ page: "b", inEvent: true }]);
    await waitFor(() => expect(text("page")).toBe("b"));
    expect(stub.types()).toEqual([]);

    forwardClick();
    await waitFor(() => expect(text("page")).toBe("next"));
    expect(stub.types()).toEqual([["push", "navigation"]]);
  });
});
