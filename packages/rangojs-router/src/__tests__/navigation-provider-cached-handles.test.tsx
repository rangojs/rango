// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { Profiler, Suspense, use, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createHandle } from "../handle.js";
import {
  createEventController,
  type EventController,
} from "../browser/event-controller.js";
import { createNavigationStore } from "../browser/navigation-store.js";
import { NavigationProvider } from "../browser/react/NavigationProvider.js";
import { useHandle } from "../browser/react/use-handle.js";
import { commitInTransition } from "../browser/partial-update.js";
import type {
  NavigationBridge,
  NavigationStore,
  NavigationUpdate,
} from "../browser/types.js";

vi.mock("../browser/scroll-restoration.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../browser/scroll-restoration.js")
  >()),
  handleNavigationEnd: vi.fn(),
  handleTraversalStart: vi.fn(),
}));

/**
 * A page rendered from a history-cache entry starts from the entry's handle
 * pushes (NavigationProvider's update subscriber, `cachedHandleData`). They
 * are set after the readers took their anchor (flushRouteState("anchor")),
 * so a crumb whose `content` is still pending never rides the page's lane: there
 * it re-suspends the crumb's revealed <Suspense> and React holds the whole
 * page until the promise resolves. Behind the anchor it lands in the task
 * that commits the page. Through the real provider.
 */

interface Crumb {
  label: string;
  content: Promise<string>;
}

const Crumbs = createHandle<Crumb, Crumb[]>(
  (segments) => segments.flat(),
  "__test_cached_handles_crumbs__",
);

const ORIGIN = "http://localhost";

let store: NavigationStore;
let controller: EventController;
let root: Root | undefined;
let log: { shown: string; task: number }[];
let task: number;
let ticking: ReturnType<typeof setTimeout> | undefined;

const text = (id: string): string =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

function settled(value: string): Promise<string> {
  return Object.assign(Promise.resolve(value), {
    status: "fulfilled",
    value,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const crumbs = (label: string, content: Promise<string>) => ({
  [Crumbs.$$id]: { R0: [{ label, content }] },
});

function CrumbContent({ content }: { content: Promise<string> }): ReactNode {
  return <span data-testid="content">{use(content)}</span>;
}

/** The last crumb, its content in a boundary every crumb shares. */
function Trail(): ReactNode {
  const last = useHandle(Crumbs).at(-1);
  return (
    <>
      <p data-testid="crumb">{last?.label}</p>
      {last ? (
        <Suspense fallback={<span data-testid="content-fallback" />}>
          <CrumbContent content={last.content} />
        </Suspense>
      ) : null}
    </>
  );
}

/** Every page renders the same shape, so the trail keeps its boundary. */
function Page({ id }: { id: string }): ReactNode {
  return (
    <>
      <Trail />
      <p data-testid="page">{id}</p>
    </>
  );
}

function mount(bridge: NavigationBridge = {} as NavigationBridge) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const initial: NavigationUpdate = {
    root: <Page id="1" />,
    metadata: { pathname: "/1", segments: [], matched: ["R0"] },
  } as unknown as NavigationUpdate;
  return act(async () => {
    root!.render(
      <Profiler
        id="app"
        onRender={() =>
          log.push({ shown: `${text("crumb")}|${text("page")}`, task })
        }
      >
        <NavigationProvider
          store={store}
          eventController={controller}
          bridge={bridge}
          initialPayload={initial}
        />
      </Profiler>,
    );
  });
}

beforeEach(() => {
  log = [];
  window.history.replaceState({ key: "/1" }, "", "/1");
  store = createNavigationStore({
    initialLocation: { href: `${ORIGIN}/1` },
    initialSegmentIds: ["R0"],
    initialHistoryKey: "/1",
  });
  controller = createEventController({
    initialLocation: new URL("/1", ORIGIN),
  });
  controller.setHandleData(crumbs("one", settled("stock 1")), ["R0"]);
  task = 0;
  const tick = () => {
    task++;
    ticking = setTimeout(tick, 0);
  };
  tick();
});

afterEach(async () => {
  clearTimeout(ticking);
  if (root) {
    const current = root;
    root = undefined;
    await act(async () => current.unmount());
  }
  document.body.replaceChildren();
});

/** The task of the commit that showed `page` first, and of `crumb|page`. */
function tasks(crumb: string, page: string): [number?, number?] {
  return [
    log.find((entry) => entry.shown.endsWith(`|${page}`))?.task,
    log.find((entry) => entry.shown === `${crumb}|${page}`)?.task,
  ];
}

describe("NavigationProvider: a history-cache page's handle pushes", () => {
  it("a link to a cached page: a crumb whose content is still pending does not hold the page", async () => {
    await mount();
    expect(text("content")).toBe("stock 1");
    const stock = deferred<string>();

    await act(async () => {
      controller.setLocation(new URL("/2", ORIGIN));
      commitInTransition(
        store.loaders,
        (update) => store.emitUpdate(update),
        [],
        {
          root: <Page id="2" />,
          metadata: {
            pathname: "/2",
            segments: [],
            matched: ["R0"],
            cachedHandleData: crumbs("two", stock.promise),
          },
        } as unknown as NavigationUpdate,
        "push",
        ["navigation"],
      );
    });

    await waitFor(() => expect(text("page")).toBe("2"));
    expect(text("crumb")).toBe("two");
    expect(log.map((entry) => entry.shown)).not.toContain("two|1");
    const [page, crumb] = tasks("two", "2");
    expect(crumb).toBe(page);

    await act(async () => {
      stock.resolve("stock 2");
      await stock.promise;
    });
    await waitFor(() => expect(text("content")).toBe("stock 2"));
  });
});
