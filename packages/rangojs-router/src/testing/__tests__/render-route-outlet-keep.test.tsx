// @vitest-environment happy-dom
/**
 * `<Outlet keep />` through renderRoute, as a consumer tests it: server routes
 * under a layout whose outlet keeps the pages it leaves mounted and hidden.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Link,
  Outlet,
  useKept,
  useKeptOutlet,
  useKeptShow,
  useLoader,
  useLocationState,
  useNavigation,
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
  useSegments,
  type OutletKeepOptions,
} from "../../client.js";
import { createLocationState } from "../../browser/react/location-state-shared.js";
import { withLocationStateKey } from "../index.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";

const LayoutLoader = {
  __brand: "loader",
  $$id: "keep#Layout",
} as LoaderDefinition<string>;
const ItemLoader = {
  __brand: "loader",
  $$id: "keep#Item",
} as LoaderDefinition<string>;
const Note = withLocationStateKey(createLocationState<string>(), "KeepNote");

let keep: OutletKeepOptions;
let log: string[];
let mounts: number;

beforeEach(() => {
  keep = { max: 1 };
  strict = false;
  log = [];
  mounts = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// `<Outlet keep />` loads its chunk on first render. A server render with
// renderToString cannot wait for it (a streaming server render does), so
// the chunk is loaded once before the hydration cases.
beforeAll(async () => {
  keep = { max: 1 };
  const { unmount, container } = await renderRoute(routes(PlainPage), {
    request: "/items/1",
  });
  await waitFor(() => expect(items(container, false)).toEqual(["1"]));
  unmount();
});

let strict = false;

function Layout(): ReactNode {
  const outlet = <Outlet keep={keep} />;
  return <main>{strict ? <StrictMode>{outlet}</StrictMode> : outlet}</main>;
}

/** One instance per mount; a show keeps it. */
function useInstance(): number {
  const [id] = useState(() => ++mounts);
  return id;
}

function Item(): ReactNode {
  const id = useInstance();
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const [search, setSearch] = useSearchParams();
  const nav = useNavigation();
  const navPath = useNavigation((state) => state.location.pathname);
  const note = useLocationState(Note);
  const { hidden } = useKept();
  const [text, setText] = useState("");
  const line = `item ${params.id}#${id} path=${pathname}${search.size ? `?${search}` : ""} nav=${nav.state}:${nav.location.pathname}/${navPath} note=${note ?? "-"} hidden=${hidden}`;
  useLayoutEffect(() => {
    log.push(`commit ${line}`);
  });
  return (
    <section data-item={params.id}>
      <p data-testid={`line-${params.id}`}>{line}</p>
      <input
        data-testid={`input-${params.id}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        data-testid={`set-${params.id}`}
        onClick={() => void setSearch({ tab: "x" })}
      />
    </section>
  );
}

/** Hidden by its own Activity or by an outer one. */
const isHidden = (element: HTMLElement): boolean =>
  element.closest('[style*="display: none"]') !== null;

/** The items drawn hidden, or the ones drawn visible. */
function items(container: HTMLElement, hidden: boolean): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-item]"))
    .filter((element) => isHidden(element) === hidden)
    .map((element) => element.dataset.item!);
}

function PlainPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  return <section data-item={id}>{id}</section>;
}

const routes = (Leaf: () => ReactNode = Item) => [
  { path: "/items", Component: Layout },
  { path: "/items/:id", Component: Leaf },
];

describe("<Outlet keep />: a page left stays mounted and hidden", () => {
  it("coming back shows the same instance with its state and DOM nodes", async () => {
    const { container, getByTestId, router } = await renderRoute(routes(), {
      request: "/items/1",
    });
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));
    fireEvent.change(getByTestId("input-1"), { target: { value: "typed" } });
    const node = container.querySelector('[data-item="1"]');

    await router.navigate("/items/2");
    expect(items(container, false)).toEqual(["2"]);
    expect(items(container, true)).toEqual(["1"]);

    await router.navigate("/items/1");
    expect(items(container, false)).toEqual(["1"]);
    expect(items(container, true)).toEqual(["2"]);
    expect(container.querySelector('[data-item="1"]')).toBe(node);
    expect((getByTestId("input-1") as HTMLInputElement).value).toBe("typed");
    // Two instances for two pages: the show mounted nothing.
    expect(mounts).toBe(2);
  });

  it("draws entries in a stable key order, so a switch moves no DOM node", async () => {
    keep = { max: 2 };
    const { container, router } = await renderRoute(routes(), {
      request: "/items/2",
    });
    await waitFor(() => expect(items(container, false)).toEqual(["2"]));
    await router.navigate("/items/1");
    await router.navigate("/items/3");
    const order = () =>
      Array.from(container.querySelectorAll<HTMLElement>("[data-item]")).map(
        (element) => element.dataset.item,
      );
    const nodes = Array.from(container.querySelectorAll("[data-item]"));
    expect(order()).toEqual(["1", "2", "3"]);
    await router.navigate("/items/2");
    await router.navigate("/items/1");
    expect(order()).toEqual(["1", "2", "3"]);
    expect(Array.from(container.querySelectorAll("[data-item]"))).toEqual(
      nodes,
    );
  });

  it("max counts the hidden entries and evicts the one left longest ago", async () => {
    const { container, router } = await renderRoute(routes(), {
      request: "/items/1",
    });
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));
    await router.navigate("/items/2");
    await router.navigate("/items/3");
    expect(items(container, false)).toEqual(["3"]);
    expect(items(container, true)).toEqual(["2"]);
    expect(mounts).toBe(3);

    await router.navigate("/items/2");
    expect(mounts).toBe(3);
    await router.navigate("/items/1");
    // Item 1 was evicted: it mounts again.
    expect(mounts).toBe(4);
    expect(items(container, true)).toEqual(["2"]);
  });

  it("max: 0 keeps nothing", async () => {
    keep = { max: 0 };
    const { container, router } = await renderRoute(routes(), {
      request: "/items/1",
    });
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));
    await router.navigate("/items/2");
    expect(items(container, true)).toEqual([]);
    await router.navigate("/items/1");
    expect(mounts).toBe(3);
  });

  it("a lower max evicts at once; Infinity keeps every page; an invalid max keeps none and is reported once", async () => {
    keep = { max: Infinity };
    const { container, router } = await renderRoute(routes(), {
      request: "/items/1",
    });
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));
    await router.navigate("/items/2");
    await router.navigate("/items/3");
    expect(items(container, true)).toEqual(["1", "2"]);

    // The next render with the lower max, here a search change on the page.
    keep = { max: 1 };
    await router.navigate("/items/3?tab=a");
    expect(items(container, true)).toEqual(["2"]);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    keep = { max: -1 };
    await router.navigate("/items/3?tab=b");
    await router.navigate("/items/4");
    expect(items(container, true)).toEqual([]);
    expect(
      error.mock.calls.filter(([message]) =>
        String(message).includes("max is how many left pages"),
      ),
    ).toHaveLength(1);
  });

  it("a key function decides the entries: one key per route reconciles a param change", async () => {
    keep = { max: 1, key: (to) => to.route };
    const { container, getByTestId, router } = await renderRoute(routes(), {
      request: "/items/1",
    });
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));
    fireEvent.change(getByTestId("input-1"), { target: { value: "typed" } });
    await router.navigate("/items/2");
    // One entry: the route's element under it changes key, so the page
    // mounts anew inside the same Activity, and nothing is hidden.
    expect(items(container, true)).toEqual([]);
    expect(items(container, false)).toEqual(["2"]);
  });
});

describe("<Outlet keep />: a hidden page reads its own location", () => {
  it("useParams, usePathname, useSearchParams, useLocationState and useNavigation read the entry's location while hidden and on the show", async () => {
    const { container, router } = await renderRoute(routes(), {
      request: "/items/1?tab=a",
      locationState: [[Note, "one"]],
    });
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));

    await router.navigate("/items/2", { state: [Note("two")] });
    expect(container.querySelector('[data-testid="line-1"]')!.textContent).toBe(
      "item 1#1 path=/items/1?tab=a nav=idle:/items/1//items/1 note=one hidden=true",
    );

    log.length = 0;
    await router.navigate("/items/1?tab=a", { state: [Note("one")] });
    const shown = log.filter((line) => line.startsWith("commit item 1"));
    // Every commit of the shown page, the first included, reads its own URL.
    expect(shown.length).toBeGreaterThan(0);
    for (const line of shown) {
      expect(line).toBe(
        "commit item 1#1 path=/items/1?tab=a nav=idle:/items/1//items/1 note=one hidden=false",
      );
    }
  });

  it("a hidden page navigates nowhere: its search-params setter, useRouter().push/replace and <Link> do nothing and warn in dev", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    function Page(): ReactNode {
      const { id } = useParams<{ id: string }>();
      const [, setSearch] = useSearchParams();
      const router = useRouter();
      return (
        <section data-item={id}>
          <button
            data-testid={`set-${id}`}
            onClick={() => void setSearch({ tab: "x" })}
          />
          <button
            data-testid={`push-${id}`}
            onClick={() => void router.push("/items/9")}
          />
          <button
            data-testid={`replace-${id}`}
            onClick={() => void router.replace("/items/9")}
          />
          <Link to="/items/9" data-testid={`link-${id}`}>
            nine
          </Link>
        </section>
      );
    }
    const { container, getByTestId, router } = await renderRoute(routes(Page), {
      request: "/items/1",
    });
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));
    await router.navigate("/items/2");

    for (const entry of ["set", "push", "replace", "link"]) {
      warn.mockClear();
      await act(async () => {
        fireEvent.click(getByTestId(`${entry}-1`));
      });
      expect(router.pathname(), entry).toBe("/items/2");
      expect(router.eventController.getLocation().search, entry).toBe("");
      expect(warn, entry).toHaveBeenCalledWith(
        expect.stringContaining("hidden by <Outlet keep />"),
      );
    }
    // Shown again, the same page navigates.
    await router.navigate("/items/1");
    await act(async () => {
      fireEvent.click(getByTestId("push-1"));
    });
    await waitFor(() => expect(router.pathname()).toBe("/items/9"));
  });

  it("useSegments reads the entry's own path while hidden and on the show", async () => {
    function Page(): ReactNode {
      const { id } = useParams<{ id: string }>();
      const pathname = usePathname();
      const segments = useSegments((state) => state.path.join("/"));
      const line = `${pathname} ${segments}`;
      useLayoutEffect(() => {
        log.push(`commit ${id} ${line}`);
      });
      return (
        <section data-item={id}>
          <p data-testid={`line-${id}`}>{line}</p>
        </section>
      );
    }
    const { container, getByTestId, router } = await renderRoute(routes(Page), {
      request: "/items/1",
    });
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));
    await router.navigate("/items/2");
    expect(getByTestId("line-1").textContent).toBe("/items/1 items/1");

    log.length = 0;
    await router.navigate("/items/1");
    const shown = log.filter((line) => line.startsWith("commit 1 "));
    expect(shown.length).toBeGreaterThan(0);
    for (const line of shown) expect(line).toBe("commit 1 /items/1 items/1");
  });
});

describe("<Outlet keep />: useKeptShow, useKept and drop", () => {
  it("useKeptShow fires on a show, never on a mount (StrictMode included); a ref-guarded effect runs again", async () => {
    strict = true;
    const shows: string[] = [];
    const effects: string[] = [];
    function Page(): ReactNode {
      const { id } = useParams<{ id: string }>();
      const once = useRef(false);
      useEffect(() => {
        effects.push(`effect ${id}${once.current ? " (guarded)" : ""}`);
        once.current = true;
      }, [id]);
      useKeptShow(() => shows.push(`show ${id}`));
      return <section data-item={id}>{id}</section>;
    }
    const { container, router } = await renderRoute(routes(Page), {
      request: "/items/1",
    });
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));
    expect(shows).toEqual([]);

    await router.navigate("/items/2");
    expect(shows).toEqual([]);
    effects.length = 0;
    await router.navigate("/items/1");
    expect(shows).toEqual(["show 1"]);
    // The show re-ran item 1's effect: its ref guard holds it.
    expect(effects).toContain("effect 1 (guarded)");
    await router.navigate("/items/2");
    expect(shows).toEqual(["show 1", "show 2"]);
  });

  it("drop(key) forgets a hidden entry: its next visit mounts it", async () => {
    keep = { max: 2, key: (to) => `item:${to.params.id}` };
    let drop!: (key: string) => void;
    function Page(): ReactNode {
      const { id } = useParams<{ id: string }>();
      useInstance();
      drop = useKeptOutlet().drop;
      return <section data-item={id}>{id}</section>;
    }
    const { container, router } = await renderRoute(routes(Page), {
      request: "/items/1",
    });
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));
    await router.navigate("/items/2");
    expect(items(container, true)).toEqual(["1"]);

    act(() => drop("item:1"));
    expect(items(container, true)).toEqual([]);
    await router.navigate("/items/1");
    expect(mounts).toBe(3);
  });
});

describe("<Outlet keep />: loaders", () => {
  it("a kept page reads its parent's loader live, not as it was at the hide", async () => {
    function KeepLayout(): ReactNode {
      return (
        <main>
          <Outlet keep={keep} />
        </main>
      );
    }
    function Page(): ReactNode {
      const { id } = useParams<{ id: string }>();
      const layout = useLoader(LayoutLoader).data;
      const own = useLoader(ItemLoader).data;
      return <section data-item={id}>{`${id} ${own} ${layout}`}</section>;
    }
    const { container, router } = await renderRoute(
      [
        {
          path: "/items",
          Component: KeepLayout,
          loaderIds: [LayoutLoader.$$id],
        },
        { path: "/items/:id", Component: Page, loaderIds: [ItemLoader.$$id] },
      ],
      {
        request: "/items/1",
        loaders: [
          [LayoutLoader, "layout#1"],
          [ItemLoader, "own:1"],
        ],
      },
    );
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));
    await router.navigate("/items/2", {
      loaders: [
        [LayoutLoader, "layout#1"],
        [ItemLoader, "own:2"],
      ],
    });
    await router.refresh({
      loaders: [
        [LayoutLoader, "layout#2"],
        [ItemLoader, "own:2"],
      ],
    });
    await router.navigate("/items/1", {
      loaders: [
        [LayoutLoader, "layout#2"],
        [ItemLoader, "own:1"],
      ],
    });
    expect(container.querySelector('[data-item="1"]')!.textContent).toBe(
      "1 own:1 layout#2",
    );
  });
});

describe("<Outlet keep />: a keeping outlet inside a kept page", () => {
  it("an inner page hidden by the outer outlet reads as hidden, at its own URL, and shows again with the inner outlet's entries intact", async () => {
    const inner: OutletKeepOptions = { max: 1 };
    const shows: string[] = [];
    function Section(): ReactNode {
      return (
        <div>
          <Outlet keep={inner} />
        </div>
      );
    }
    function Page(): ReactNode {
      const { id } = useParams<{ id: string }>();
      useKeptShow(() => shows.push(`show ${id}`));
      return <Item />;
    }
    keep = { max: 1, key: (to) => `section:${to.params.section}` };
    const { container, getByTestId, router } = await renderRoute(
      [
        { path: "/s", Component: Layout },
        { path: "/s/:section", Component: Section },
        { path: "/s/:section/:id", Component: Page },
      ],
      { request: "/s/a/1" },
    );
    await waitFor(() => expect(items(container, false)).toEqual(["1"]));
    await router.navigate("/s/a/2");
    expect(items(container, true)).toEqual(["1"]);
    fireEvent.change(getByTestId("input-2"), { target: { value: "typed" } });

    await router.navigate("/s/b/3");
    expect(items(container, false)).toEqual(["3"]);
    // Section a, kept by the outer outlet, still holds its inner entries.
    expect(items(container, true).sort()).toEqual(["1", "2"]);
    expect(getByTestId("line-2").textContent).toBe(
      "item 2#2 path=/s/a/2 nav=idle:/s/a/2//s/a/2 note=- hidden=true",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => {
      fireEvent.click(getByTestId("set-2"));
    });
    expect(router.pathname()).toBe("/s/b/3");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("hidden by <Outlet keep />"),
    );

    await router.navigate("/s/a/2");
    expect(items(container, false)).toEqual(["2"]);
    expect(getByTestId("line-2").textContent).toBe(
      "item 2#2 path=/s/a/2 nav=idle:/s/a/2//s/a/2 note=- hidden=false",
    );
    expect((getByTestId("input-2") as HTMLInputElement).value).toBe("typed");
    expect(shows).toEqual(["show 2"]);
    // Three pages, three mounts: section a's two came back as they were.
    expect(mounts).toBe(3);
    await router.navigate("/s/a/1");
    expect(mounts).toBe(3);
    expect(shows).toEqual(["show 2", "show 1"]);
  });
});

describe("<Outlet keep />: server and browser", () => {
  it("hydrates the shown page in a visible Activity with no mismatch", async () => {
    function Page(): ReactNode {
      const { id } = useParams<{ id: string }>();
      return <section data-item={id}>{id}</section>;
    }
    const result = await renderRoute(routes(Page), {
      request: "/items/1",
      hydrate: true,
    });
    await waitFor(() => expect(items(result.container, false)).toEqual(["1"]));
    expect(result.serverHtml).toContain("<!--&-->");
    expect(result.recoverableErrors).toEqual([]);
  });

  // The other way round (the browser keeps, the server did not) has no test:
  // React 19.3 never finishes hydrating a visible Activity over HTML without
  // its marker (Chromium's tab hangs, happy-dom runs out of memory).
  it("fails loudly in dev, naming the outlet, when the server keeps and the browser does not", async () => {
    function DriftLayout(): ReactNode {
      const server = typeof window === "undefined";
      return (
        <main>
          <Outlet keep={server ? { max: 1 } : undefined} />
        </main>
      );
    }
    const result = await renderRoute(
      [
        { path: "/items", Component: DriftLayout },
        { path: "/items/:id", Component: PlainPage },
      ],
      { request: "/items/1", hydrate: true },
    );
    await waitFor(() => expect(result.recoverableErrors).toHaveLength(1));
    expect(result.recoverableErrors[0]).toContain("Hydration failed");
    expect(result.recoverableErrors[0]).toContain("<DriftLayout>");
    expect(result.recoverableErrors[0]).toContain("<Outlet");
  });
});
