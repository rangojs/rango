// @vitest-environment happy-dom
/**
 * `<Outlet keep />` in a clientUrls() group, drawn as client-root.test.tsx
 * draws it: the group segment's OutletProvider (segment-system.tsx) around
 * ClientUrlsRoot, a click's frame through beginClientUrlNavigation as
 * navigation-bridge.ts calls it, and the canonical commit as a new segment
 * set in a transition, then the intent's clear. The router store stays at
 * "/": outside a frame, the URL hooks read no params.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import {
  Profiler,
  startTransition,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Outlet, useLoader, type OutletKeepOptions } from "../client.js";
import { OutletProvider } from "../outlet-provider.js";
import { OutletContext } from "../outlet-context.js";
import { clientUrls } from "../client-urls/client-urls.js";
import { ClientUrlsRoot } from "../client-urls/client-root.js";
import {
  beginClientUrlNavigation,
  clearClientUrlNavigationRegistry,
} from "../client-urls/navigation.js";
import { useParams } from "../browser/react/use-params.js";
import { useSearchParams } from "../browser/react/use-search-params.js";
import type { LoaderDefinition, ResolvedSegment } from "../types.js";
import { createEventController } from "../browser/event-controller.js";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "../browser/react/context.js";

const loaderDef = (name: string) =>
  ({ __brand: "loader", $$id: `keep#${name}` }) as LoaderDefinition<string>;
const CartLoader = loaderDef("Cart");
const ListLoader = loaderDef("List");
const ItemLoader = loaderDef("Item");

let keep: OutletKeepOptions;
let log: string[];
let frames: string[];
let instances: number;

/** Each [data-page] element's text, visible ones or hidden ones. */
function pages(visible: boolean): string {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-page]"))
    .filter((el) => !el.closest('[style*="display: none"]') === visible)
    .map((el) => el.textContent)
    .join(" + ");
}

/** What was visible after each commit, consecutive equal ones folded. */
function screens(): string[] {
  return frames.filter((frame, index) => frames[index - 1] !== frame);
}

function useInstance(name: string): number {
  const [id] = useState(() => {
    const next = ++instances;
    log.push(`mount ${name}#${next}`);
    return next;
  });
  return id;
}

function useCommitLog(line: string): void {
  useEffect(() => {
    log.push(line);
  });
}

function Shell(): ReactNode {
  const { data } = useLoader(CartLoader);
  return (
    <main>
      <p data-testid="cart">{data}</p>
      <Outlet keep={keep} />
    </main>
  );
}

function List(): ReactNode {
  const { data } = useLoader(ListLoader);
  const id = useInstance("List");
  return <p data-page="list">{`List#${id}(${data})`}</p>;
}

function Item(): ReactNode {
  const { data } = useLoader(ItemLoader);
  const cart = useLoader(CartLoader).data;
  const params = useParams();
  const [search] = useSearchParams();
  const id = useInstance("Item");
  const [text, setText] = useState("");
  let outlet = useContext(OutletContext);
  while (outlet && !outlet.segment) outlet = outlet.parent ?? null;
  useCommitLog(
    `commit Item#${id} ${data} params=${JSON.stringify(params)} search=${search.toString()}`,
  );
  return (
    <div data-page="item" data-segment={outlet?.segment?.id ?? ""}>
      {`Item#${id}(${data}) ${params.id ?? "?"} ${cart}${text ? ` "${text}"` : ""}`}
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
  segment?: string;
}

let setSegment!: (segment: GroupSegment) => void;

function Group({ initial }: { initial: GroupSegment }): ReactNode {
  const [segment, set] = useState(initial);
  setSegment = set;
  const [store] = useState(
    () =>
      ({
        eventController: createEventController({
          initialLocation: new URL("http://localhost/"),
        }),
        origin: "http://localhost",
      }) as NavigationStoreContextValue,
  );
  return (
    <NavigationStoreContext.Provider value={store}>
      <Profiler id="group" onRender={() => frames.push(pages(true))}>
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
          <ClientUrlsRoot definition={shop} routeId={segment.routeId} />
        </OutletProvider>
      </Profiler>
    </NavigationStoreContext.Provider>
  );
}

const cart = (value = "cart:1") => ({ [CartLoader.$$id]: value });
const atList = (list = "list:1", cartValue = "cart:1"): GroupSegment => ({
  routeId: LIST,
  params: {},
  data: { ...cart(cartValue), [ListLoader.$$id]: list },
});
const atItem = (
  id: string,
  item = `item:${id}`,
  cartValue = "cart:1",
): GroupSegment => ({
  routeId: ITEM,
  params: { id },
  data: { ...cart(cartValue), [ItemLoader.$$id]: item },
});
const atAbout = (cartValue = "cart:1"): GroupSegment => ({
  routeId: ABOUT,
  params: {},
  data: cart(cartValue),
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
): Promise<void> {
  await act(async () => {
    startTransition(() => setSegment(segment));
    presentation?.clear();
  });
}

async function go(href: string, segment: GroupSegment): Promise<void> {
  await commit(await click(href), segment);
}

/** Back/Forward: no frame, a commit with the history cache's data. */
async function back(segment: GroupSegment): Promise<void> {
  await act(async () => startTransition(() => setSegment(segment)));
}

async function mountGroup(initial: GroupSegment): Promise<RenderResult> {
  let result!: RenderResult;
  await act(async () => {
    result = render(<Group initial={initial} />);
  });
  await waitFor(() => expect(pages(true)).not.toBe(""));
  return result;
}

const mounts = () => log.filter((line) => line.startsWith("mount"));

beforeAll(async () => {
  // Load the keeping outlet's chunk once, so each case starts from a
  // resolved lazy component as a page that has rendered one does.
  keep = { max: 1 };
  instances = 0;
  log = [];
  frames = [];
  await mountGroup(atList());
  cleanup();
});

beforeEach(() => {
  keep = { max: 2 };
  log = [];
  frames = [];
  instances = 0;
});

afterEach(() => {
  cleanup();
  clearClientUrlNavigationRegistry();
  window.history.replaceState(null, "", "/");
});

describe("<Outlet keep /> in a clientUrls() group", () => {
  it("a hidden page keeps its own loader data after the next page replaced the group's", async () => {
    await mountGroup(atList());
    await go("/items/7", atItem("7"));
    expect(pages(true)).toBe("Item#2(item:7) ? cart:1");
    expect(pages(false)).toBe("List#1(list:1)");
  });

  it("keys a group page by its route: a param change reconciles the one page, the others stay kept", async () => {
    const result = await mountGroup(atList());
    await go("/about", atAbout());
    await go("/items/7", atItem("7"));
    fireEvent.change(result.getByTestId("input-3"), {
      target: { value: "typed" },
    });
    await go("/items/8", atItem("8"));
    expect(pages(true)).toBe('Item#3(item:8) ? cart:1 "typed"');
    expect(pages(false)).toBe("List#1(list:1) + About#2");
  });

  it("a click onto a kept page shows it at the click with its kept data, then the response's, with no mount and no loading()", async () => {
    await mountGroup(atItem("7"));
    await go("/", atList());
    frames.length = 0;
    log.length = 0;

    const presentation = await click("/items/7");
    expect(pages(true)).toBe("Item#1(item:7) 7 cart:1");
    await commit(presentation, atItem("7", "item:7b"));
    expect(screens()).not.toContain("Loading item");
    expect(pages(true)).toBe("Item#1(item:7b) ? cart:1");
    expect(mounts()).toEqual([]);
  });

  it("a kept page reads its parent layout's loader live at the click", async () => {
    await mountGroup(atItem("7"));
    await go("/", atList());
    // The cart changes while Item 7 is hidden (an action on List).
    await back(atList("list:1", "cart:2"));
    await click("/items/7");
    expect(pages(true)).toBe("Item#1(item:7) 7 cart:2");
  });

  it("at a click onto a kept page, its reads walk to the segment on screen, not the one it was hidden under", async () => {
    const seg = (segment: GroupSegment, id: string) => ({
      ...segment,
      segment: id,
    });
    await mountGroup(seg(atItem("7"), "R-item"));
    await go("/", seg(atList(), "R-list"));
    await click("/items/7");
    const shown = Array.from(
      document.querySelectorAll<HTMLElement>('[data-page="item"]'),
    ).find((el) => !el.closest('[style*="display: none"]'));
    // Handle pushes file under the walk's segment: the store holds R-list
    // until the commit.
    expect(shown?.dataset.segment).toBe("R-list");
  });

  it("the page shown at a click reads the click's params and search in its first commit", async () => {
    await mountGroup(atList());
    await go("/items/7?tab=specs", atItem("7"));
    await go("/about", atAbout());
    log.length = 0;
    const again = await click("/items/7?tab=reviews");
    const first = log.find((line) => line.startsWith("commit Item"));
    await commit(again, atItem("7"));
    expect(first).toBe(
      'commit Item#2 item:7 params={"id":"7"} search=tab=reviews',
    );
  });

  it("a page drawn on a click that a newer click replaced before its commit is not kept", async () => {
    await mountGroup(atList());
    await click("/about");
    expect(pages(true)).toBe("About#2");
    const newer = await click("/items/7");
    await commit(newer, atItem("7"));
    expect(pages(true)).toBe("Item#3(item:7) ? cart:1");
    // List was left for real; About never committed.
    expect(pages(false)).toBe("List#1(list:1)");

    log.length = 0;
    await go("/about", atAbout());
    expect(mounts()).toEqual(["mount About#4"]);
  });

  it("Back to a kept page shows the same instance; one evicted by max mounts anew", async () => {
    keep = { max: 1 };
    await mountGroup(atList());
    await go("/items/7", atItem("7"));
    await go("/about", atAbout());
    expect(pages(false)).toBe("Item#2(item:7) ? cart:1");

    log.length = 0;
    await back(atItem("7", "item:7 (cache)"));
    expect(pages(true)).toBe("Item#2(item:7 (cache)) ? cart:1");
    expect(mounts()).toEqual([]);

    await back(atList("list:1 (cache)"));
    expect(pages(true)).toBe("List#4(list:1 (cache))");
    expect(mounts()).toEqual(["mount List#4"]);
  });
});
