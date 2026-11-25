// @vitest-environment happy-dom
/**
 * SPIKE (kept pages, claims B1-B9): `<Outlet keep={{ max }} />` keeps the
 * pages a layout's outlet leaves mounted and hidden in <Activity>
 * (src/outlet-keep.tsx). Throwaway: these tests answer the plan's claims and
 * print what they saw ([Bn] lines), they are not meant to merge.
 *
 * Two harnesses:
 * - a clientUrls() group drawn as client-root.test.tsx draws it: the group
 *   segment's OutletProvider (what segment-system.tsx renders) around
 *   ClientUrlsRoot, a click's optimistic frame through
 *   beginClientUrlNavigation as navigation-bridge.ts calls it, and the
 *   canonical commit as a new segment (routeId, params, loader data) set in a
 *   transition, then the intent's clear, as partial-update.ts hands it over.
 *   No router store: hooks outside a frame read their defaults.
 * - server routes under a server layout through renderRoute (the router
 *   store, NavigationProvider and production's renderSegments).
 *
 * Every commit is recorded by a Profiler: `frames` holds what was visible
 * after each one, so "the first visible render after show" is read from
 * output. Each page logs its instance (`mount X#n` once per instance: a
 * lazy useState initializer, which a hide/show does not re-run) and its
 * commits. In the group harness a committed page reads no params (no router
 * store: `?`); a frame reads the click's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
} from "@testing-library/react";
import {
  Component,
  Profiler,
  startTransition,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Outlet, useLoader, useLocationState } from "../../client.js";
import { OutletProvider } from "../../outlet-provider.js";
import type { OutletKeepOptions } from "../../outlet-keep.js";
import { clientUrls } from "../../client-urls/client-urls.js";
import { ClientUrlsRoot } from "../../client-urls/client-root.js";
import {
  beginClientUrlNavigation,
  clearClientUrlNavigationRegistry,
} from "../../client-urls/navigation.js";
import { useParams } from "../../browser/react/use-params.js";
import { usePathname } from "../../browser/react/use-pathname.js";
import { useSearchParams } from "../../browser/react/use-search-params.js";
import { useNavigation } from "../../browser/react/use-navigation.js";
import { useHandle } from "../../browser/react/use-handle.js";
import { usePushHandle } from "../../browser/react/use-push-handle.js";
import { createHandle } from "../../handle.js";
import { createLocationState } from "../../browser/react/location-state-shared.js";
import { withLocationStateKey } from "../index.js";
import type { LoaderDefinition, ResolvedSegment } from "../../types.js";
import { OutletContext } from "../../outlet-context.js";
import { renderRoute } from "../render-route.js";

const loaderDef = (name: string) =>
  ({
    __brand: "loader",
    $$id: `keep-spike#${name}`,
  }) as LoaderDefinition<string>;
const CartLoader = loaderDef("Cart");
const ListLoader = loaderDef("List");
const ItemLoader = loaderDef("Item");

let keepOptions: OutletKeepOptions | undefined;
let log: string[];
let frames: string[];
let instances: number;
let renders: string[];

/** What a page shows: its text, for each [data-page] element visible or not. */
function pages(visible: boolean): string {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-page]"))
    .filter((el) => !el.closest('[style*="display: none"]') === visible)
    .map((el) => el.textContent)
    .join(" + ");
}

let tick: number;
let tickQueued: boolean;
let ticks: number[];

// As render-route-push-handle.test.tsx measures it: a tick moves at the next
// microtask after a commit, and the last commit of a tick is what the browser
// could paint. Under act() a passive effect's update lands in the same tick,
// so a frame it corrects looks on time here; the browser can paint it.
function record(): void {
  const title = document.querySelector('[data-testid="title"]')?.textContent;
  frames.push(
    title === undefined ? pages(true) : `${pages(true)} | title=${title}`,
  );
  ticks.push(tick);
  if (tickQueued) return;
  tickQueued = true;
  queueMicrotask(() => {
    tick++;
    tickQueued = false;
  });
}

/** Every commit, consecutive equal ones folded. */
function screens(): string[] {
  return frames.filter((frame, index) => frames[index - 1] !== frame);
}

/** The last commit of each tick, consecutive equal ones folded. */
function painted(): string[] {
  const last = frames.filter((_, index) => ticks[index + 1] !== ticks[index]);
  return last.filter((frame, index) => last[index - 1] !== frame);
}

function resetFrames(): void {
  frames.length = 0;
  ticks.length = 0;
}

function useInstance(name: string): number {
  const [id] = useState(() => {
    const next = ++instances;
    log.push(`mount ${name}#${next}`);
    return next;
  });
  return id;
}

/** Logs to `log` only after a commit, so a render React threw away or
 * suspended does not count as shown. */
function useCommitLog(line: string): void {
  useEffect(() => {
    log.push(line);
  });
}

beforeEach(() => {
  renders = [];
  keepOptions = undefined;
  log = [];
  frames = [];
  ticks = [];
  tick = 0;
  tickQueued = false;
  instances = 0;
});

afterEach(() => {
  cleanup();
  clearClientUrlNavigationRegistry();
  window.history.replaceState(null, "", "/");
});

// ---------------------------------------------------------------------------
// Harness 1: a clientUrls() group.

function Shell(): ReactNode {
  const { data } = useLoader(CartLoader);
  return (
    <main>
      <p data-testid="cart">{data}</p>
      <Outlet keep={keepOptions} />
    </main>
  );
}

function List(): ReactNode {
  renders.push("List render start");
  let data: string;
  try {
    data = useLoader(ListLoader).data;
  } catch (error) {
    renders.push(`List threw: ${(error as Error).message?.slice(0, 60)}`);
    throw error;
  }
  const id = useInstance("List");
  useCommitLog(`commit List#${id} ${data}`);
  return <p data-page="list">{`List#${id}(${data})`}</p>;
}

function Item(): ReactNode {
  const { data } = useLoader(ItemLoader);
  const params = useParams();
  const [search] = useSearchParams();
  const id = useInstance("Item");
  const [text, setText] = useState("");
  // The segment usePushHandle files this page's values under (its walk).
  let outlet = useContext(OutletContext);
  while (outlet && !outlet.segment) outlet = outlet.parent ?? null;
  useCommitLog(
    `commit Item#${id} ${data} params=${JSON.stringify(params)} search=${search.toString()}`,
  );
  return (
    <div data-page="item" data-segment={outlet?.segment?.id ?? ""}>
      {`Item#${id}(${data}) ${params.id ?? "?"}${text ? ` "${text}"` : ""}`}
      <input
        data-testid={`input-${id}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  );
}

function About(): ReactNode {
  const id = useInstance("About");
  return <p data-page="about">{`About#${id}`}</p>;
}

const shop = clientUrls(({ layout, path, loader, loading }) => [
  layout(Shell, () => [
    loader(CartLoader),
    path("/", List, { name: "list" }, () => [loader(ListLoader)]),
    path("/items/:id", Item, { name: "item" }, () => [
      loader(ItemLoader),
      loading(<p data-page="loading">Loading item</p>),
    ]),
    path("/about", About, { name: "about" }),
  ]),
]);
const LIST = "client-route-0";
const ITEM = "client-route-1";
const ABOUT = "client-route-2";

interface GroupSegment {
  routeId: string;
  params: Record<string, string>;
  data?: Record<string, unknown>;
  streams?: Record<string, unknown>;
  /** The route segment's id (segment-system.tsx gives the group's provider
   *  its route segment; each group route is a segment of its own). */
  segment?: string;
}

let setSegment!: (segment: GroupSegment) => void;

class Catch extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render(): ReactNode {
    return this.state.error ? (
      <p data-page="error">{`error: ${this.state.error.message}`}</p>
    ) : (
      this.props.children
    );
  }
}

function Group({ initial }: { initial: GroupSegment }): ReactNode {
  const [segment, set] = useState(initial);
  setSegment = set;
  return (
    <Profiler id="group" onRender={record}>
      <Catch>
        <OutletProvider
          content={null}
          loaderData={segment.data}
          loaderStreams={segment.streams}
          segment={
            segment.segment
              ? ({ id: segment.segment } as ResolvedSegment)
              : undefined
          }
        >
          <ClientUrlsRoot
            definition={shop}
            routeId={segment.routeId}
            params={segment.params}
          />
        </OutletProvider>
      </Catch>
    </Profiler>
  );
}

const cart = { [CartLoader.$$id]: "cart:1" };
const atList = (list = "list:1", extra = cart): GroupSegment => ({
  routeId: LIST,
  params: {},
  data: { ...extra, [ListLoader.$$id]: list },
});
const atItem = (id: string, item = `item:${id}`): GroupSegment => ({
  routeId: ITEM,
  params: { id },
  data: { ...cart, [ItemLoader.$$id]: item },
});
const atAbout = (): GroupSegment => ({
  routeId: ABOUT,
  params: {},
  data: cart,
});

type Presentation = ReturnType<typeof beginClientUrlNavigation>;

async function click(href: string): Promise<Presentation> {
  let presentation: Presentation = null;
  await act(async () => {
    presentation = beginClientUrlNavigation(
      new URL(href, "http://localhost"),
      new AbortController().signal,
    );
  });
  return presentation;
}

async function commit(
  presentation: Presentation,
  segment: GroupSegment,
  lane: "transition" | "urgent" = "transition",
): Promise<void> {
  await act(async () => {
    if (lane === "transition") startTransition(() => setSegment(segment));
    else setSegment(segment);
    presentation?.clear();
  });
}

/** A click and its canonical commit. */
async function go(href: string, segment: GroupSegment): Promise<void> {
  await commit(await click(href), segment);
}

function mountGroup(initial: GroupSegment): RenderResult {
  return render(<Group initial={initial} />);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("SPIKE B1: a kept group page keeps its loader data", () => {
  it("with a per-entry provider, the hidden List keeps list:1 after Item replaced the group's provider", async () => {
    keepOptions = { max: 2 };
    mountGroup(atList());
    await go("/items/7", atItem("7"));

    console.log(`[B1] visible: ${pages(true)} | hidden: ${pages(false)}`);
    console.log(`[B1] log: ${JSON.stringify(log)}`);
    console.log(`[B1] List renders: ${JSON.stringify(renders)}`);
    expect(pages(true)).toBe("Item#2(item:7) ?");
    expect(pages(false)).toBe("List#1(list:1)");
    expect(renders.some((line) => line.startsWith("List threw"))).toBe(false);
  });

  it("control (isolate: false): the hidden List, drawn under the live context, throws while hidden; React drops the error and keeps its last DOM", async () => {
    keepOptions = { max: 2, isolate: false };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mountGroup(atList());
    renders.length = 0;
    await go("/items/7", atItem("7"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const whileHidden = {
      renders: [...renders],
      visible: pages(true),
      hidden: pages(false),
      consoleErrors: errors.mock.calls.length,
    };
    // Its show: the frame hands List's loader a pending stream (the rule at
    // client-root.tsx:171-173), so the show waits for the response.
    const presentation = await click("/");
    const atClick = pages(true);
    await commit(presentation, atList("list:2"));
    errors.mockRestore();
    console.log(`[B1 control] while hidden: ${JSON.stringify(whileHidden)}`);
    console.log(
      `[B1 control] at the show's click: ${atClick}; after its commit: ${pages(true)}`,
    );
    expect(whileHidden.renders).toContain(
      'List threw: useLoader: Loader "keep-spike#List" data not found in contex',
    );
    expect(whileHidden.hidden).toBe("List#1(list:1)");
    expect(whileHidden.consoleErrors).toBe(0);
    expect(atClick).toBe("Item#2(item:7) ?");
    expect(pages(true)).toBe("List#1(list:2)");
  });

  it("control (isolate: false), two pages of one loader: the hidden Item 7 shows Item 8's data", async () => {
    keepOptions = { max: 2, isolate: false };
    mountGroup(atItem("7"));
    await go("/", atList());
    await go("/items/8", atItem("8"));
    console.log(
      `[B1 control same loader] visible: ${pages(true)} | hidden: ${pages(false)}`,
    );
    expect(pages(false)).toBe("Item#1(item:8) ? + List#2(list:1)");
  });
});

describe("SPIKE B3: show at the click from kept data, then the response", () => {
  async function keptItem(): Promise<void> {
    keepOptions = { max: 2 };
    mountGroup(atItem("7"));
    await go("/", atList());
    resetFrames();
    log.length = 0;
  }

  it("transition commit with a streaming loader: the kept page shows item:7 at the click, holds it through the commit, then swaps once to item:7b", async () => {
    await keptItem();
    const presentation = await click("/items/7");
    const atClick = pages(true);

    const stream = deferred<unknown>();
    await commit(presentation, {
      routeId: ITEM,
      params: { id: "7" },
      data: cart,
      streams: { [ItemLoader.$$id]: stream.promise },
    });
    const whileStreaming = pages(true);
    await act(async () => stream.resolve("item:7b"));

    console.log(`[B3 transition] at click: ${atClick}`);
    console.log(`[B3 transition] commit, stream open: ${whileStreaming}`);
    console.log(`[B3 transition] screens: ${JSON.stringify(screens())}`);
    console.log(`[B3 transition] log: ${JSON.stringify(log)}`);
    expect(atClick).toBe("Item#1(item:7) 7");
    expect(whileStreaming).toBe("Item#1(item:7) 7");
    expect(screens()).toEqual([
      "List#2(list:1)",
      "Item#1(item:7) 7",
      "Item#1(item:7b) ?",
    ]);
    expect(log.filter((line) => line.startsWith("mount"))).toEqual([]);
  });

  it("urgent commit with a streaming loader: the route's loading() replaces the kept page until the data lands", async () => {
    await keptItem();
    const presentation = await click("/items/7");
    const stream = deferred<unknown>();
    await commit(
      presentation,
      {
        routeId: ITEM,
        params: { id: "7" },
        data: cart,
        streams: { [ItemLoader.$$id]: stream.promise },
      },
      "urgent",
    );
    await act(async () => stream.resolve("item:7b"));
    console.log(`[B3 urgent] screens: ${JSON.stringify(screens())}`);
    console.log(`[B3 urgent] log: ${JSON.stringify(log)}`);
    expect(screens()).toContain("Loading item");
  });

  it("baseline (no keep): the click shows the route's loading(), the Item mounts anew", async () => {
    mountGroup(atItem("7"));
    await go("/", atList());
    resetFrames();
    log.length = 0;
    const presentation = await click("/items/7");
    const atClick = pages(true);
    await commit(presentation, atItem("7", "item:7b"));
    console.log(`[B3 baseline] at click: ${atClick}`);
    console.log(`[B3 baseline] screens: ${JSON.stringify(screens())}`);
    console.log(`[B3 baseline] log: ${JSON.stringify(log)}`);
    expect(atClick).toBe("Loading item");
  });
});

describe("SPIKE B4: an action while a page is hidden", () => {
  it("the hidden List is not updated by the action; its show reads it from the show's own response", async () => {
    keepOptions = { max: 2 };
    mountGroup(atList());
    await go("/items/7", atItem("7"));

    // The action's revalidation lands on the page on screen (Item 7), with
    // the cart and the list written.
    await act(async () =>
      startTransition(() =>
        setSegment({
          ...atItem("7", "item:7"),
          data: {
            [CartLoader.$$id]: "cart:2",
            [ItemLoader.$$id]: "item:7",
          },
        }),
      ),
    );
    const hiddenAfterAction = pages(false);
    resetFrames();

    const presentation = await click("/");
    const atClick = pages(true);
    await commit(
      presentation,
      atList("list:2", { [CartLoader.$$id]: "cart:2" }),
    );
    console.log(`[B4b] hidden after the action: ${hiddenAfterAction}`);
    console.log(`[B4b] screens on show: ${JSON.stringify(screens())}`);
    expect(hiddenAfterAction).toBe("List#1(list:1)");
    expect(atClick).toBe("List#1(list:1)");
    expect(screens()).toEqual([
      "Item#2(item:7) ?",
      "List#1(list:1)",
      "List#1(list:2)",
    ]);
  });
});

describe("SPIKE B5: a kept group page's handle pushes at the click", () => {
  it("at a frame onto a kept page, its pushes go to its own route segment, which the store does not hold until the commit", async () => {
    keepOptions = { max: 2 };
    const seg = (segment: GroupSegment, id: string) => ({
      ...segment,
      segment: id,
    });
    mountGroup(seg(atItem("7"), "R-item"));
    await go("/", seg(atList(), "R-list"));
    await click("/items/7");
    const kept = document
      .querySelector('[data-page="item"]:not([style*="display"])')
      ?.getAttribute("data-segment");
    console.log(
      `[B5 group] kept Item at the click files under: ${kept}; screen's segment: R-list`,
    );
    expect(kept).toBe("R-item");
  });
});

describe("SPIKE B6: a hidden group page's location, and the shown page's first frame", () => {
  it("the hidden page keeps the params and search it was drawn at; the shown page reads the click's in its first frame", async () => {
    keepOptions = { max: 2 };
    mountGroup(atList());
    // Item 7 shown through a frame, committed.
    await go("/items/7?tab=specs", atItem("7"));
    await go("/about", atAbout());
    log.length = 0;
    // Back to Item 7 with another search: the frame and its first commit.
    const again = await click("/items/7?tab=reviews");
    const firstShownCommit = log.find((line) => line.startsWith("commit Item"));
    await commit(again, atItem("7"));
    console.log(`[B6 group] first commit after show: ${firstShownCommit}`);
    expect(firstShownCommit).toBe(
      'commit Item#2 item:7 params={"id":"7"} search=tab=reviews',
    );
  });
});

describe("SPIKE B7: entry keys and the A1 contract", () => {
  it('by "params" (route and params): /items/7 to /items/8 mounts a new Item; the typed text stays with 7 (A1 contract broken)', async () => {
    keepOptions = { max: 2, by: "params" };
    const result = mountGroup(atItem("7"));
    fireEvent.change(result.getByTestId("input-1"), {
      target: { value: "typed on 7" },
    });
    await go("/items/8", atItem("8"));
    console.log(
      `[B7 params] visible: ${pages(true)} | hidden: ${pages(false)} | mounts: ${JSON.stringify(log.filter((l) => l.startsWith("mount")))}`,
    );
    expect(pages(true)).toBe("Item#2(item:8) ?");
    expect(pages(false)).toBe('Item#1(item:7) ? "typed on 7"');
  });

  it('by "route": /items/7 to /items/8 reconciles the one Item (A1 kept), and List and About are still kept beside it', async () => {
    keepOptions = { max: 2, by: "route" };
    const result = mountGroup(atList());
    await go("/about", atAbout());
    await go("/items/7", atItem("7"));
    fireEvent.change(result.getByTestId("input-3"), {
      target: { value: "typed on 7" },
    });
    await go("/items/8", atItem("8"));
    console.log(
      `[B7 route] visible: ${pages(true)} | hidden: ${pages(false)} | mounts: ${JSON.stringify(log.filter((l) => l.startsWith("mount")))}`,
    );
    expect(pages(true)).toBe('Item#3(item:8) ? "typed on 7"');
    expect(pages(false)).toBe("List#1(list:1) + About#2");
  });

  it("baseline (no keep): /items/7 to /items/8 reconciles the one Item", async () => {
    const result = mountGroup(atItem("7"));
    fireEvent.change(result.getByTestId("input-1"), {
      target: { value: "typed on 7" },
    });
    await go("/items/8", atItem("8"));
    console.log(`[B7 baseline] visible: ${pages(true)}`);
    expect(pages(true)).toBe('Item#1(item:8) ? "typed on 7"');
  });
});

describe("SPIKE B8: Back and Forward to a kept entry, and past the cap", () => {
  // popstate presents no frame (navigation-bridge.ts renders the history
  // cache with forceAwait and commits it, in a transition when the route has
  // transition()): here, a commit with settled data and no click.
  async function back(segment: GroupSegment): Promise<void> {
    await act(async () => startTransition(() => setSegment(segment)));
  }

  it("Back to a kept entry shows the same instance with the history cache's data; one evicted by max mounts anew", async () => {
    keepOptions = { max: 1 };
    mountGroup(atList());
    await go("/items/7", atItem("7"));
    await go("/about", atAbout());
    const afterTour = { visible: pages(true), hidden: pages(false) };

    log.length = 0;
    resetFrames();
    await back(atItem("7", "item:7 (cache)"));
    const backToKept = { screens: screens(), log: [...log] };

    log.length = 0;
    resetFrames();
    await back(atList("list:1 (cache)"));
    const backPastCap = { screens: screens(), log: [...log] };

    console.log(`[B8] after tour (max 1): ${JSON.stringify(afterTour)}`);
    console.log(`[B8] back to kept Item: ${JSON.stringify(backToKept)}`);
    console.log(`[B8] back to evicted List: ${JSON.stringify(backPastCap)}`);
    expect(afterTour).toEqual({
      visible: "About#3",
      hidden: "Item#2(item:7) ?",
    });
    expect(backToKept.screens).toEqual(["Item#2(item:7 (cache)) ?"]);
    expect(backToKept.log.filter((l) => l.startsWith("mount"))).toEqual([]);
    expect(backPastCap.log.filter((l) => l.startsWith("mount"))).toEqual([
      "mount List#4",
    ]);
  });
});

describe("SPIKE B9: no growth over a repeated tour", () => {
  it("the same tour twice holds the same kept trees and mounts nothing new the second time", async () => {
    keepOptions = { max: 2 };
    mountGroup(atList());
    const tour = async () => {
      await go("/items/7", atItem("7"));
      await go("/about", atAbout());
      await go("/", atList());
    };
    const count = () => document.querySelectorAll("[data-page]").length;
    await tour();
    const first = { trees: count(), mounts: instances };
    await tour();
    const second = { trees: count(), mounts: instances };
    console.log(
      `[B9 group] after tour 1: ${JSON.stringify(first)}, after tour 2: ${JSON.stringify(second)}`,
    );
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Harness 2: server routes under a server layout (renderRoute).

const Titles = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_keep_spike_titles__",
);
const Note = withLocationStateKey(
  createLocationState<{ text: string }>(),
  "KeepSpikeNote",
);
let navState: string[];

function ServerLayout(): ReactNode {
  return (
    <Profiler id="layout" onRender={record}>
      <p data-testid="title">{useHandle(Titles).join(" / ")}</p>
      <Outlet keep={keepOptions} />
    </Profiler>
  );
}

function ServerPage(): ReactNode {
  const { data } = useLoader(ItemLoader);
  const params = useParams();
  const pathname = usePathname();
  const [search] = useSearchParams();
  const note = useLocationState(Note);
  const state = useNavigation((n) =>
    n.isStreaming ? `${n.state}+streaming` : n.state,
  );
  const id = useInstance("Page");
  usePushHandle(Titles)(`Client ${data}`);
  navState.push(`Page#${id} ${state}`);
  return (
    <p data-page="page">
      {`Page#${id}(${data}) ${params.id} ${pathname}${search.size ? `?${search}` : ""} note=${note?.text ?? "-"} nav=${state}`}
    </p>
  );
}

const titleNow = () =>
  document.querySelector('[data-testid="title"]')?.textContent ?? "";

async function mountServer(options: { transition?: boolean } = {}) {
  navState = [];
  return renderRoute(
    [
      { path: "/items", Component: ServerLayout, sharedLayout: true },
      {
        path: "/items/:id",
        Component: ServerPage,
        ...(options.transition && { transition: {} }),
      },
    ],
    {
      request: "/items/1?tab=a",
      loaders: [[ItemLoader, "one"]],
      handles: [[Titles, ["Server"], 1]],
    },
  );
}

describe("SPIKE B2: a kept server-route page keeps its data through its own element", () => {
  for (const isolate of [true, false]) {
    it(`isolate: ${isolate}: hidden Page 1 keeps "one" after /items/2 commits "two"; Back to /items/1 reuses its instance`, async () => {
      keepOptions = { max: 2, isolate };
      const { router } = await mountServer();
      await act(async () =>
        router.navigate("/items/2?tab=b", { loaders: [[ItemLoader, "two"]] }),
      );
      const afterLeave = { visible: pages(true), hidden: pages(false) };
      await act(async () =>
        router.navigate("/items/1?tab=a", {
          loaders: [[ItemLoader, "one again"]],
        }),
      );
      const afterReturn = { visible: pages(true), hidden: pages(false) };
      console.log(
        `[B2 isolate=${isolate}] after leave: ${JSON.stringify(afterLeave)}; after return: ${JSON.stringify(afterReturn)}; mounts: ${JSON.stringify(log.filter((l) => l.startsWith("mount")))}`,
      );
      expect(afterLeave.hidden).toMatch(/^Page#1\(one\)/);
      expect(afterReturn.visible).toMatch(/^Page#1\(one again\)/);
      expect(log.filter((l) => l.startsWith("mount"))).toEqual([
        "mount Page#1",
        "mount Page#2",
      ]);
    });
  }
});

describe("SPIKE B5: handles of a kept page", () => {
  it("a hidden page's pushes are withdrawn; shown again they come back; no commit shows both pages' values or the wrong one", async () => {
    keepOptions = { max: 2 };
    const { router } = await mountServer();
    const titles: string[] = [];
    const sample = () => titles.push(titleNow());
    sample();
    resetFrames();
    await act(async () =>
      router.navigate("/items/2", {
        loaders: [[ItemLoader, "two"]],
        handles: [[Titles, ["Server"], 1]],
      }),
    );
    sample();
    await act(async () =>
      router.navigate("/items/1", {
        loaders: [[ItemLoader, "one"]],
        handles: [[Titles, ["Server"], 1]],
      }),
    );
    sample();
    console.log(`[B5] titles: ${JSON.stringify(titles)}`);
    console.log(`[B5] commits: ${JSON.stringify(screens())}`);
    console.log(`[B5] painted: ${JSON.stringify(painted())}`);
    // A painted frame whose shown page's data is not the title's client value.
    const wrong = painted().filter((screen) => {
      const match = /^Page#\d+\(([^)]*)\).*\| title=(.*)$/.exec(screen);
      return !match || match[2] !== `Server / Client ${match[1]}`;
    });
    console.log(`[B5] screens with the wrong title: ${JSON.stringify(wrong)}`);
    expect(wrong).toEqual([]);
    console.log(
      `[B5] handle data: ${JSON.stringify(router.handleData(Titles))}`,
    );
    expect(titles).toEqual([
      "Server / Client one",
      "Server / Client two",
      "Server / Client one",
    ]);
  });
});

describe("SPIKE B6: a hidden server-route page's location", () => {
  it.each([
    ["the show reads the outlet's location", { max: 2 }],
    ["control (showLocation: false)", { max: 2, showLocation: false }],
  ] as const)(
    "%s: hidden Page 1 answers /items/1?tab=a and its own note while /items/2 is shown; its show",
    async (label, options) => {
      keepOptions = options;
      const { router } = await mountServer();
      await act(async () =>
        router.navigate("/items/1?tab=a", {
          loaders: [[ItemLoader, "one"]],
          state: [Note({ text: "on one" })],
          replace: true,
        }),
      );
      navState.length = 0;
      await act(async () =>
        router.navigate("/items/2?tab=b", {
          loaders: [[ItemLoader, "two"]],
          state: [Note({ text: "on two" })],
        }),
      );
      const hidden = pages(false);
      const visible = pages(true);
      const leaving = [...navState];
      resetFrames();
      navState.length = 0;
      await act(async () =>
        router.navigate("/items/1?tab=c", {
          loaders: [[ItemLoader, "one again"]],
          state: [Note({ text: "on one, again" })],
        }),
      );
      console.log(
        `[B6 server, ${label}] visible: ${visible} | hidden: ${hidden}`,
      );
      console.log(
        `[B6 server, ${label}] useNavigation renders while leaving: ${JSON.stringify(leaving)}`,
      );
      console.log(
        `[B6 server, ${label}] show of Page 1, commits: ${JSON.stringify(screens())}`,
      );
      console.log(
        `[B6 server, ${label}] show of Page 1, painted: ${JSON.stringify(painted())}`,
      );
      console.log(
        `[B6 server, ${label}] show of Page 1, useNavigation renders: ${JSON.stringify(navState)}`,
      );
      // A commit that shows Page 1 at another location than the one shown.
      const stale = screens().filter(
        (screen) =>
          screen.startsWith("Page#1") && !screen.includes(" 1 /items/1?tab=c "),
      );
      console.log(
        `[B6 server, ${label}] commits at a stale location: ${JSON.stringify(stale)}`,
      );
      if ("showLocation" in options) expect(stale).not.toEqual([]);
      else expect(stale).toEqual([]);
      expect(hidden).toBe("Page#1(one) 1 /items/1?tab=a note=on one nav=idle");
      expect(visible).toBe("Page#2(two) 2 /items/2?tab=b note=on two nav=idle");
    },
  );
});

describe("SPIKE B6: useNavigation in a page hidden while its navigation streams", () => {
  it("Page 1, hidden while /items/2 still streams, keeps that value while hidden, and its show's first commit reads it", async () => {
    keepOptions = { max: 2 };
    const { router } = await mountServer();
    const tail = deferred<void>();
    await act(async () =>
      router.navigate("/items/2", {
        loaders: [[ItemLoader, "two"]],
        streamUntil: tail.promise,
      }),
    );
    const streaming = { visible: pages(true), hidden: pages(false) };
    await act(async () => tail.resolve());
    const settled = { visible: pages(true), hidden: pages(false) };
    resetFrames();
    await act(async () =>
      router.navigate("/items/1", { loaders: [[ItemLoader, "one again"]] }),
    );
    console.log(
      `[B6 nav] while /items/2 streams: ${JSON.stringify(streaming)}`,
    );
    console.log(`[B6 nav] after it settled: ${JSON.stringify(settled)}`);
    console.log(
      `[B6 nav] show of Page 1, commits: ${JSON.stringify(screens())}`,
    );
    console.log(
      `[B6 nav] show of Page 1, painted: ${JSON.stringify(painted())}`,
    );
    expect(settled.hidden).toBe(
      "Page#1(one) 1 /items/1?tab=a note=- nav=idle+streaming",
    );
    // The show's first commit reads the value the page had when hidden; a
    // passive effect corrects it in the next commit.
    expect(screens()).toEqual([
      "Page#1(one again) 1 /items/1 note=- nav=idle+streaming | title=Server / Client two",
      "Page#1(one again) 1 /items/1 note=- nav=idle | title=Server / Client one again",
    ]);
  });
});

describe("SPIKE B9: no growth over a repeated tour (server routes, subscriptions)", () => {
  it.each([
    ["keep max 2", { max: 2 }],
    ["no keep (baseline)", undefined],
  ] as const)(
    "%s: the same tour twice holds the same kept trees and router subscriptions",
    async (label, options) => {
      keepOptions = options;
      const { router } = await mountServer();
      const controller = router.eventController;
      let active = 0;
      for (const method of [
        "subscribe",
        "subscribeToHandles",
        "subscribeToClientHandles",
      ] as const) {
        const original = controller[method].bind(controller) as (
          ...args: unknown[]
        ) => () => void;
        vi.spyOn(controller, method).mockImplementation(((
          ...args: unknown[]
        ) => {
          active++;
          const unsubscribe = original(...args);
          return () => {
            active--;
            unsubscribe();
          };
        }) as never);
      }
      const tour = async () => {
        for (const id of ["2", "3", "1"]) {
          await act(async () =>
            router.navigate(`/items/${id}`, { loaders: [[ItemLoader, id]] }),
          );
        }
      };
      const trees = () => document.querySelectorAll("[data-page]").length;
      await tour();
      const first = {
        trees: trees(),
        mounts: instances,
        subscriptions: active,
      };
      await tour();
      const second = {
        trees: trees(),
        mounts: instances,
        subscriptions: active,
      };
      console.log(
        `[B9 server, ${label}] after tour 1: ${JSON.stringify(first)}, after tour 2: ${JSON.stringify(second)}`,
      );
      expect(second.subscriptions).toBe(first.subscriptions);
      if (options) expect(second).toEqual(first);
    },
  );
});
