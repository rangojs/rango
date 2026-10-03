// @vitest-environment happy-dom
import { memo, use, useEffect, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  configure,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import {
  createLocationState,
  Link,
  Outlet,
  useLoader,
  useLocationState,
  useParams,
  useSearchParams,
} from "../../client.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../dom.entry.js";
import { withLocationStateKey } from "../index.js";

// #1029: a reader sees a history entry's location state only together with
// that entry's tree. A navigation whose commit React holds (a transition
// waiting on a loader) keeps the entry being left on screen, with that
// entry's state, until the destination commits.
//
// Every reader below records what each render showed, so a render that pairs
// one entry's state with the other entry's data fails by name, whether or not
// it ever reached the DOM.

type Page = { page: number; items: string[] };

const pageItems = (page: number): string[] =>
  [1, 2, 3].map((item) => `p${page}-${item}`);
const pageData = (page: number): Page => ({ page, items: pageItems(page) });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function duplicates(list: readonly string[]): string[] {
  return list.filter((item, index) => list.indexOf(item) !== index);
}

afterEach(() => {
  cleanup();
  configure({ reactStrictMode: false });
  vi.restoreAllMocks();
  window.history.replaceState(null, "");
});

describe("renderRoute: location state commits with its entry's tree (#1029)", () => {
  const ProductsLoader = {
    __brand: "loader",
  } as unknown as LoaderDefinition<Page>;
  const Carried = withLocationStateKey(
    createLocationState<string[]>({ clearOnReload: true }),
    "CommitCarried",
  );

  // The load-more list of the issue, as an app writes it: no duplicate filter.
  function loadMore(): {
    List: () => ReactNode;
    renders: string[][];
  } {
    const renders: string[][] = [];
    function List(): ReactNode {
      const carried = useLocationState(Carried) ?? [];
      const { data } = useLoader(ProductsLoader);
      const all = [...carried, ...data.items];
      renders.push(all);
      return (
        <>
          <ul data-testid="items">
            {all.map((item, index) => (
              // Index keys: the duplicated list must render, not throw.
              <li key={index}>{item}</li>
            ))}
          </ul>
          <Link
            to={`/products?page=${data.page + 1}`}
            state={[Carried(all)]}
            data-testid="more"
          >
            Load more
          </Link>
        </>
      );
    }
    return { List, renders };
  }

  const shown = (root: { getByTestId(id: string): HTMLElement }): string[] =>
    Array.from(root.getByTestId("items").querySelectorAll("li")).map(
      (li) => li.textContent ?? "",
    );

  it.each([
    { label: "push, client mount" },
    { replace: true, label: "replace, client mount" },
    { hydrate: true, label: "push, hydrated document" },
    { strict: true, label: "push, client mount, StrictMode" },
    {
      hydrate: true,
      strict: true,
      label: "push, hydrated document, StrictMode",
    },
  ])(
    "a held load-more navigation shows no carried item twice ($label)",
    async ({ hydrate = false, replace = false, strict = false }) => {
      configure({ reactStrictMode: strict });
      const { List, renders } = loadMore();
      const result = await renderRoute(
        [{ path: "/products", Component: List, transition: {} }],
        {
          request: "/products?page=1",
          loaders: [[ProductsLoader, pageData(1)]],
          hydrate,
        },
      );
      if ("recoverableErrors" in result) {
        expect(result.recoverableErrors).toEqual([]);
      }
      expect(shown(result)).toEqual(pageItems(1));

      const next = deferred<Page>();
      await result.router.navigate("/products?page=2", {
        state: [Carried(pageItems(1))],
        replace,
        loaders: [[ProductsLoader, next.promise]],
      });

      // The router has moved to the destination entry; React still shows the
      // entry being left.
      expect(Carried.read()).toEqual(pageItems(1));
      expect(shown(result)).toEqual(pageItems(1));

      await act(async () => next.resolve(pageData(2)));

      expect(shown(result)).toEqual([...pageItems(1), ...pageItems(2)]);
      expect(renders.filter((all) => duplicates(all).length > 0)).toEqual([]);
    },
  );

  it("a navigation held by any suspended read keeps the leaving entry's state (<Link state>)", async () => {
    // No loader: the destination suspends on its own promise, the way a
    // client component reading a streamed value does.
    const pages = new Map<number, Promise<string[]>>([
      [1, Promise.resolve(pageItems(1))],
    ]);
    const second = deferred<string[]>();
    pages.set(2, second.promise);
    await pages.get(1);

    const renders: string[][] = [];
    function List(): ReactNode {
      const [search] = useSearchParams();
      const page = Number(search.get("page") ?? "1");
      const carried = useLocationState(Carried) ?? [];
      const items = use(pages.get(page)!);
      const all = [...carried, ...items];
      renders.push(all);
      return (
        <>
          <ul data-testid="items">
            {all.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          <Link
            to={`/products?page=${page + 1}`}
            state={[Carried(all)]}
            data-testid="more"
          >
            Load more
          </Link>
        </>
      );
    }

    const result = await renderRoute(
      [{ path: "/products", Component: List, transition: {} }],
      { request: "/products?page=1" },
    );
    expect(shown(result)).toEqual(pageItems(1));

    // The click starts an async navigation: the entry is pushed when it
    // commits, and the commit is what React then holds.
    fireEvent.click(result.getByTestId("more"));
    await waitFor(() => expect(Carried.read()).toEqual(pageItems(1)));
    expect(shown(result)).toEqual(pageItems(1));

    await act(async () => second.resolve(pageItems(2)));
    expect(shown(result)).toEqual([...pageItems(1), ...pageItems(2)]);
    expect(renders.filter((all) => duplicates(all).length > 0)).toEqual([]);
  });

  it("a reader in a layout shared by both entries changes with the page below it", async () => {
    const Sort = withLocationStateKey(
      createLocationState<{ order: string }>(),
      "CommitSort",
    );
    const pairs: string[] = [];
    function Shell(): ReactNode {
      return (
        <div>
          <Outlet />
        </div>
      );
    }
    // The layout reader and the page data are recorded by one component so a
    // pair is one render: the page reads the loader, the layout slot above it
    // is read through the same commit.
    function Page(): ReactNode {
      const sort = useLocationState(Sort);
      const plain = useLocationState<{ from?: string }>();
      const { data } = useLoader(ProductsLoader);
      const pair = `page ${data.page}: sort ${sort?.order ?? "none"}, from ${plain?.from ?? "none"}`;
      pairs.push(pair);
      return <p data-testid="pair">{pair}</p>;
    }

    const result = await renderRoute(
      [
        { path: "/products", Component: Shell },
        { path: "/products", Component: Page, transition: {} },
      ],
      {
        request: "/products?page=1",
        loaders: [[ProductsLoader, pageData(1)]],
      },
    );
    const pair = () => result.getByTestId("pair").textContent;
    expect(pair()).toBe("page 1: sort none, from none");

    // Typed state, held.
    const second = deferred<Page>();
    await result.router.navigate("/products?page=2", {
      state: [Sort({ order: "asc" })],
      loaders: [[ProductsLoader, second.promise]],
    });
    expect(pair()).toBe("page 1: sort none, from none");
    await act(async () => second.resolve(pageData(2)));
    expect(pair()).toBe("page 2: sort asc, from none");

    // Plain state, held: the typed slot of the entry being left stays until
    // the destination commits, then is gone with that entry.
    const third = deferred<Page>();
    await result.router.navigate("/products?page=3", {
      state: { from: "list" },
      loaders: [[ProductsLoader, third.promise]],
    });
    expect(pair()).toBe("page 2: sort asc, from none");
    await act(async () => third.resolve(pageData(3)));
    expect(pair()).toBe("page 3: sort none, from list");

    expect([...new Set(pairs)]).toEqual([
      "page 1: sort none, from none",
      "page 2: sort asc, from none",
      "page 3: sort none, from list",
    ]);
  });

  it("a reader that mounts while a navigation is held sees the state of the entry on screen", async () => {
    const pairs: string[] = [];
    function Late(): ReactNode {
      const carried = useLocationState(Carried) ?? [];
      const { data } = useLoader(ProductsLoader);
      const pair = `page ${data.page}: ${carried.join("+") || "none"}`;
      pairs.push(pair);
      return <p data-testid="late">{pair}</p>;
    }
    function Page(): ReactNode {
      const [open, setOpen] = useState(false);
      // The page's own read is what holds the navigation.
      useLoader(ProductsLoader);
      return (
        <div>
          <button data-testid="open" onClick={() => setOpen(true)} />
          {open && <Late />}
        </div>
      );
    }
    const result = await renderRoute(
      [{ path: "/products", Component: Page, transition: {} }],
      { request: "/products?page=1", loaders: [[ProductsLoader, pageData(1)]] },
    );

    const next = deferred<Page>();
    await result.router.navigate("/products?page=2", {
      state: [Carried(pageItems(1))],
      loaders: [[ProductsLoader, next.promise]],
    });
    expect(Carried.read()).toEqual(pageItems(1));

    // An urgent update in the tree on screen: the entry being left.
    await act(async () => {
      fireEvent.click(result.getByTestId("open"));
    });
    expect(result.getByTestId("late").textContent).toBe("page 1: none");

    await act(async () => next.resolve(pageData(2)));
    expect(result.getByTestId("late").textContent).toBe(
      `page 2: ${pageItems(1).join("+")}`,
    );
    expect(pairs).not.toContain(`page 1: ${pageItems(1).join("+")}`);
  });

  it("a held navigation superseded by another never shows its state", async () => {
    const { List, renders } = loadMore();
    const result = await renderRoute(
      [{ path: "/products", Component: List, transition: {} }],
      { request: "/products?page=1", loaders: [[ProductsLoader, pageData(1)]] },
    );

    const never = deferred<Page>();
    await result.router.navigate("/products?page=2", {
      state: [Carried(["superseded"])],
      loaders: [[ProductsLoader, never.promise]],
    });
    expect(shown(result)).toEqual(pageItems(1));

    await result.router.navigate("/products?page=3", {
      state: [Carried(pageItems(1))],
      loaders: [[ProductsLoader, pageData(3)]],
    });
    expect(shown(result)).toEqual([...pageItems(1), ...pageItems(3)]);
    expect(renders.flat()).not.toContain("superseded");
  });

  it("an urgent commit changes state and params in one render", async () => {
    const pairs: string[] = [];
    function List(): ReactNode {
      const { page } = useParams<{ page: string }>();
      const carried = useLocationState(Carried) ?? [];
      pairs.push(`${page}:${carried.join("+") || "none"}`);
      return <p data-testid="pair">{pairs.at(-1)}</p>;
    }
    const result = await renderRoute(
      [{ path: "/list/:page", Component: List }],
      { request: "/list/1" },
    );

    await result.router.navigate("/list/2", { state: [Carried(["a"])] });
    expect(result.getByTestId("pair").textContent).toBe("2:a");
    await result.router.navigate("/list/3", { state: [Carried(["a", "b"])] });
    expect(result.getByTestId("pair").textContent).toBe("3:a+b");

    expect([...new Set(pairs)]).toEqual(["1:none", "2:a", "3:a+b"]);
  });
});

describe("renderRoute: flash state and static writes under #1029", () => {
  const ProductsLoader = {
    __brand: "loader",
  } as unknown as LoaderDefinition<Page>;
  const Flash = withLocationStateKey(
    createLocationState<{ text: string }>({ flash: true }),
    "CommitFlash",
  );
  const Note = withLocationStateKey(
    createLocationState<{ text: string }>(),
    "CommitNote",
  );

  it("a flash value on a held navigation is shown with the destination, cleared from history, and shown until the entry's state next changes", async () => {
    const pairs: string[] = [];
    function Page(): ReactNode {
      const flash = useLocationState(Flash);
      const { data } = useLoader(ProductsLoader);
      const pair = `page ${data.page}: ${flash?.text ?? "none"}`;
      pairs.push(pair);
      return <p data-testid="pair">{pair}</p>;
    }
    const result = await renderRoute(
      [{ path: "/products", Component: Page, transition: {} }],
      { request: "/products?page=1", loaders: [[ProductsLoader, pageData(1)]] },
    );
    const pair = () => result.getByTestId("pair").textContent;

    const second = deferred<Page>();
    await result.router.navigate("/products?page=2", {
      state: [Flash({ text: "saved" })],
      loaders: [[ProductsLoader, second.promise]],
    });
    expect(pair()).toBe("page 1: none");
    // Not read yet: the slot is still on the entry.
    expect(Flash.read()).toEqual({ text: "saved" });

    await act(async () => second.resolve(pageData(2)));
    expect(pair()).toBe("page 2: saved");
    expect(Flash.read()).toBeUndefined();

    // The clear changed history, not what the entry was committed with: a
    // tree update of the same entry keeps the message.
    // (refresh() renders the render-time loader seed, page 1.)
    await result.router.refresh();
    expect(pair()).toBe("page 1: saved");

    // The next entry carries no flash.
    await result.router.navigate("/products?page=3", {
      state: [Note({ text: "n" })],
      loaders: [[ProductsLoader, pageData(3)]],
    });
    expect(pair()).toBe("page 3: none");
    // Never on the entry being left while the navigation was held.
    expect(pairs.indexOf("page 1: saved")).toBeGreaterThan(
      pairs.indexOf("page 2: saved"),
    );
  });

  it("a flash reader that mounts after the clear shows the value the entry was committed with", async () => {
    function Late(): ReactNode {
      return (
        <p data-testid="late">{useLocationState(Flash)?.text ?? "none"}</p>
      );
    }
    function Page(): ReactNode {
      const flash = useLocationState(Flash);
      const [late, setLate] = useState(false);
      return (
        <div>
          <p data-testid="first">{flash?.text ?? "none"}</p>
          <button data-testid="show-late" onClick={() => setLate(true)} />
          {late && <Late />}
        </div>
      );
    }
    const result = await renderRoute([{ path: "/notes", Component: Page }], {
      request: "/notes",
      locationState: [[Flash, { text: "saved" }]],
    });
    expect(result.getByTestId("first").textContent).toBe("saved");
    expect(Flash.read()).toBeUndefined();

    fireEvent.click(result.getByTestId("show-late"));
    expect(result.getByTestId("late").textContent).toBe("saved");
  });

  it("write() and delete() change the history entry, not what readers show: a reader sees them when the entry is next committed", async () => {
    function Page(): ReactNode {
      const note = useLocationState(Note);
      const [late, setLate] = useState(false);
      return (
        <div>
          <p data-testid="mounted">{note?.text ?? "none"}</p>
          <button data-testid="show-late" onClick={() => setLate(true)} />
          {late && <Late />}
        </div>
      );
    }
    function Late(): ReactNode {
      return <p data-testid="late">{useLocationState(Note)?.text ?? "none"}</p>;
    }
    const result = await renderRoute([{ path: "/notes", Component: Page }], {
      request: "/notes",
    });
    const text = (id: string) => result.getByTestId(id).textContent;

    act(() => Note.write({ text: "written" }));
    expect(Note.read()).toEqual({ text: "written" });
    expect(text("mounted")).toBe("none");

    // A reader that mounts now shows what the others show.
    fireEvent.click(result.getByTestId("show-late"));
    expect(text("late")).toBe("none");
    expect(text("mounted")).toBe("none");

    // A return to the entry commits it as history holds it.
    await act(async () => {
      window.dispatchEvent(new Event("popstate"));
    });
    expect(text("mounted")).toBe("written");
    expect(text("late")).toBe("written");

    act(() => Note.delete());
    expect(Note.read()).toBeUndefined();
    expect(text("mounted")).toBe("written");

    await act(async () => {
      window.dispatchEvent(new Event("popstate"));
    });
    expect(text("mounted")).toBe("none");
  });

  // Readers are context consumers: a commit that changes the entry's location
  // state renders each of them once, in the update that renders the tree. A
  // commit that leaves every reader's value as it was renders none.
  it("a navigation renders readers once when the entry's state changes, and not at all when it does not", async () => {
    const renders = { note: 0, other: 0 };
    let note: { text: string } | undefined;
    const NoteReader = memo(function NoteReader(): ReactNode {
      renders.note += 1;
      note = useLocationState(Note);
      return <p data-testid="note">{note?.text ?? "none"}</p>;
    });
    const OtherReader = memo(function OtherReader(): ReactNode {
      renders.other += 1;
      return <p>{useLocationState(Flash)?.text ?? "none"}</p>;
    });
    function Page(): ReactNode {
      return (
        <div>
          <NoteReader />
          <OtherReader />
        </div>
      );
    }
    const { getByTestId, router } = await renderRoute(
      [{ path: "/notes", Component: Page }],
      { request: "/notes" },
    );
    expect(renders).toEqual({ note: 1, other: 1 });

    await router.navigate("/notes?step=2", {
      state: [Note({ text: "pushed" })],
    });
    expect(getByTestId("note").textContent).toBe("pushed");
    expect(renders).toEqual({ note: 2, other: 2 });

    // The reader's own value carried to the next entry.
    await router.navigate("/notes?step=3", { state: [Note(note!)] });
    expect(renders).toEqual({ note: 2, other: 2 });

    // An entry without state: the Note reader drops its value.
    await router.navigate("/notes?step=4", { replace: true });
    expect(getByTestId("note").textContent).toBe("none");
    expect(renders).toEqual({ note: 3, other: 3 });

    // Between two entries without state, and on a navigation that leaves
    // history alone.
    await router.navigate("/notes?step=5", { replace: true });
    await router.navigate("/notes?step=6");
    expect(renders).toEqual({ note: 3, other: 3 });
  });

  it("an object-valued slot keeps its identity when another slot changes: its reader's effects and memoized children do not run again", async () => {
    type FilterValue = { colors: string[]; range: { min: number } };
    const Filter = withLocationStateKey(
      createLocationState<FilterValue>(),
      "CommitFilter",
    );
    const seen: Array<FilterValue | undefined> = [];
    let renders = 0;
    let effects = 0;
    let childRenders = 0;
    const Child = memo(function Child({
      filter,
    }: {
      filter: FilterValue | undefined;
    }): ReactNode {
      childRenders += 1;
      return <p data-testid="colors">{filter?.colors.join("+") ?? "none"}</p>;
    });
    const FilterReader = memo(function FilterReader(): ReactNode {
      const filter = useLocationState(Filter);
      renders += 1;
      seen.push(filter);
      useEffect(() => {
        effects += 1;
      }, [filter]);
      return <Child filter={filter} />;
    });
    function Page(): ReactNode {
      return (
        <div>
          <FilterReader />
          <p data-testid="note">{useLocationState(Note)?.text ?? "none"}</p>
        </div>
      );
    }
    const { getByTestId, router } = await renderRoute(
      [{ path: "/list", Component: Page }],
      { request: "/list" },
    );

    await router.navigate("/list?step=2", {
      state: [
        Filter({ colors: ["red", "blue"], range: { min: 3 } }),
        Note({ text: "one" }),
      ],
    });
    expect(getByTestId("colors").textContent).toBe("red+blue");
    const held = seen.at(-1)!;
    const before = { renders, effects, childRenders };

    // The filter is carried forward as the reader holds it; the note changes.
    await router.navigate("/list?step=3", {
      state: [Filter(held), Note({ text: "two" })],
    });
    expect(getByTestId("note").textContent).toBe("two");
    expect(seen.at(-1)).toBe(held);
    // One render: the context value changed. Nothing below it ran.
    expect({ renders, effects, childRenders }).toEqual({
      ...before,
      renders: before.renders + 1,
    });

    // An equal object that is not the one the reader holds is a new value.
    await router.navigate("/list?step=4", {
      state: [
        Filter({ colors: ["red", "blue"], range: { min: 3 } }),
        Note({ text: "two" }),
      ],
    });
    expect(seen.at(-1)).toEqual(held);
    expect(seen.at(-1)).not.toBe(held);
    expect(effects).toBe(before.effects + 1);
  });

  it("a reader's value is a copy: changing the object passed to the navigation afterwards does not reach it", async () => {
    const List = withLocationStateKey(
      createLocationState<string[]>(),
      "CommitList",
    );
    function Page(): ReactNode {
      return (
        <p data-testid="list">{(useLocationState(List) ?? []).join("+")}</p>
      );
    }
    const { getByTestId, router } = await renderRoute(
      [{ path: "/list", Component: Page }],
      { request: "/list" },
    );
    const passed = ["a"];
    await router.navigate("/list?step=2", { state: [List(passed)] });
    passed.push("b");
    await router.refresh();
    expect(getByTestId("list").textContent).toBe("a");
  });

  it("router.navigate() writes a history entry only for `state` or `replace: true`", async () => {
    function Page(): ReactNode {
      return <p data-testid="note">{useLocationState(Note)?.text ?? "none"}</p>;
    }
    const { getByTestId, router } = await renderRoute(
      [{ path: "/notes", Component: Page }],
      { request: "/notes", locationState: [[Note, { text: "seeded" }]] },
    );
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const note = () => getByTestId("note").textContent;

    // No history write: the entry, and what readers show, stay.
    await router.navigate("/notes?step=2");
    await router.navigate("/notes?step=3", { replace: false });
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(note()).toBe("seeded");

    await router.navigate("/notes?step=4", {
      state: [Note({ text: "pushed" })],
    });
    expect(pushState).toHaveBeenCalledOnce();
    expect(note()).toBe("pushed");

    // A replace without state drops the entry's location state.
    await router.navigate("/notes?step=5", { replace: true });
    expect(replaceState).toHaveBeenCalledOnce();
    expect(pushState).toHaveBeenCalledOnce();
    expect(note()).toBe("none");
  });

  // renderRoute has one location, so a back/forward restores no tree: a
  // popstate event hands readers the entry history.state holds, the way the
  // router's popstate commit does.
  it("a popstate event is a back/forward onto the entry: readers take it as it is, an empty flash slot included", async () => {
    function Page(): ReactNode {
      const note = useLocationState(Note);
      const flash = useLocationState(Flash);
      const plain = useLocationState<{ from?: string }>();
      return (
        <p data-testid="entry">
          {`${note?.text ?? "none"}|${flash?.text ?? "none"}|${plain?.from ?? "none"}`}
        </p>
      );
    }
    const { getByTestId, unmount } = await renderRoute(
      [{ path: "/notes", Component: Page }],
      {
        locationState: [
          [Note, { text: "first" }],
          [Flash, { text: "saved" }],
        ],
      },
    );
    const entry = () => getByTestId("entry").textContent;
    expect(entry()).toBe("first|saved|none");
    expect(Flash.read()).toBeUndefined();

    await act(async () => {
      window.history.replaceState(
        { [Note.__rsc_ls_key]: { text: "second" }, state: { from: "list" } },
        "",
      );
      window.dispatchEvent(new Event("popstate"));
    });
    expect(entry()).toBe("second|none|list");

    // The listener goes with the tree.
    unmount();
    expect(() => window.dispatchEvent(new Event("popstate"))).not.toThrow();
  });
});
