// @vitest-environment happy-dom
import { Profiler, Suspense, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  Outlet,
  useHandle,
  useLoader,
  useNavigation,
  useParams,
  usePathname,
  useSearchParams,
  useSegments,
} from "../../client.js";
import { createHandle } from "../../handle.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

// Userland (#1046, hooks review card p1): a component that first mounts
// while React holds a transition() page (a quick menu opened during the wait)
// reads the page on screen from every router hook, as the header beside it
// does, until that page commits; then it moves with it. A reader that mounts
// with the page, after it, or in a page shown at once starts on that page.

const Titles = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_late_reader_titles__",
);
const ItemLoader = { __brand: "loader" } as unknown as LoaderDefinition<string>;

let frames: string[];
let freshRenders: string[];
let stub: ReturnType<typeof installViewTransitionStub> | undefined;

const text = (id: string): string =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

// Every hook a header reads, in one component, every reader shape: the full
// navigation state, a selector of it, the URL hooks, a params selector, a
// handle selector and a segments selector.
function useRoute(): string {
  const nav = useNavigation();
  const idle = useNavigation((n) => n.state === "idle");
  const pathname = usePathname();
  const [search] = useSearchParams();
  const params = useParams();
  const id = useParams((p) => p.id);
  const title = useHandle(Titles, (titles) => titles.at(-1));
  const path = useSegments((s) => s.path.join("/"));
  return [
    `${nav.state} ${nav.location.pathname}`,
    idle ? "idle" : "loading",
    `${pathname}?${search}`,
    `${params.id}/${id}`,
    title,
    path,
  ].join("|");
}

function Header(): ReactNode {
  return <p data-testid="header">{useRoute()}</p>;
}

function QuickMenu(): ReactNode {
  return <p data-testid="menu">{useRoute()}</p>;
}

function Shell(): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Profiler
      id="shell"
      onRender={() =>
        frames.push(`${text("header")} # ${text("menu")} # ${text("item")}`)
      }
    >
      <Header />
      <button data-testid="open" onClick={() => setOpen(true)} />
      {open && <QuickMenu />}
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        <Outlet />
      </Suspense>
    </Profiler>
  );
}

// Mounts with the destination's own commit (React renders it in the held
// transition), as a new page's components do.
function Fresh(): ReactNode {
  const route = useRoute();
  freshRenders.push(route);
  return <p data-testid="fresh">{route}</p>;
}

function Item(): ReactNode {
  const { data } = useLoader(ItemLoader);
  return (
    <>
      <p data-testid="item">{data}</p>
      {data === "two" && <Fresh />}
    </>
  );
}

const ONE = "loading /items/1|loading|/items/1?tab=a|1/1|Item one|items/1";
const ONE_IDLE = "idle /items/1|idle|/items/1?tab=a|1/1|Item one|items/1";
const TWO = "idle /items/2|idle|/items/2?tab=b|2/2|Item two|items/2";

async function open(): Promise<void> {
  await act(async () => {
    fireEvent.click(document.querySelector('[data-testid="open"]')!);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

beforeEach(() => {
  frames = [];
  freshRenders = [];
  stub = undefined;
});

afterEach(() => {
  cleanup();
  stub?.uninstall();
});

describe.each([
  { variant: "with a view transition", vt: true },
  { variant: "without a view transition", vt: false },
])(
  "renderRoute: a reader that mounts while a page is held reads the page on screen ($variant)",
  ({ vt }) => {
    async function mount() {
      if (vt) stub = installViewTransitionStub();
      return renderRoute(
        [
          { path: "/items/:id", Component: Shell },
          { path: "/items/:id", Component: Item, transition: {} },
        ],
        {
          request: "/items/1?tab=a",
          loaders: [[ItemLoader, "one"]],
          handles: [[Titles, ["Item one"]]],
        },
      );
    }

    // Expected failure until W1 lands (dc-t96): today the menu starts on the
    // destination. Turns red when fixed; then make it an `it`.
    it.fails("a quick menu opened during the wait shows the page being left, then moves with the page", async () => {
      const { router } = await mount();
      expect(text("header")).toBe(ONE_IDLE);

      let resolve!: (item: string) => void;
      const next = new Promise<string>((r) => (resolve = r));
      await router.navigate("/items/2?tab=b", {
        loaders: [[ItemLoader, next]],
        handles: [[Titles, ["Item two"]]],
      });
      // The handle stream has been read; React still holds the page.
      await settle();
      expect(text("item")).toBe("one");
      expect(text("header")).toBe(ONE);

      await open();
      await settle();
      expect(text("menu")).toBe(ONE);
      expect(text("header")).toBe(ONE);

      await act(async () => {
        resolve("two");
        await next;
      });
      await waitFor(() => expect(text("item")).toBe("two"));
      expect(text("header")).toBe(TWO);
      expect(text("menu")).toBe(TWO);

      // No committed frame pairs the page being left with the destination.
      expect(
        frames.filter((f) => f.endsWith("# one") && f.includes("/items/2")),
      ).toEqual([]);
      expect(
        frames.filter((f) => f.endsWith("# two") && f.includes("/items/1")),
      ).toEqual([]);
    });

    it("a reader that mounts after the page commits starts on it", async () => {
      const { router } = await mount();
      let resolve!: (item: string) => void;
      const next = new Promise<string>((r) => (resolve = r));
      await router.navigate("/items/2?tab=b", {
        loaders: [[ItemLoader, next]],
        handles: [[Titles, ["Item two"]]],
      });
      await act(async () => {
        resolve("two");
        await next;
      });
      await waitFor(() => expect(text("item")).toBe("two"));
      await settle();

      await open();
      expect(text("menu")).toBe(TWO);
      expect(text("header")).toBe(TWO);
    });

    it("a reader that mounts with the held page starts on that page", async () => {
      const { router } = await mount();
      let resolve!: (item: string) => void;
      const next = new Promise<string>((r) => (resolve = r));
      await router.navigate("/items/2?tab=b", {
        loaders: [[ItemLoader, next]],
        handles: [[Titles, ["Item two"]]],
      });
      await settle();
      expect(text("fresh")).toBe("");

      await act(async () => {
        resolve("two");
        await next;
      });
      await waitFor(() => expect(text("item")).toBe("two"));
      expect(text("fresh")).toBe(TWO);
      expect(freshRenders).not.toContain(ONE);
      expect(freshRenders).not.toContain(ONE_IDLE);
    });

    it("a reader that mounts in a page shown at once (transition: false) starts on that page", async () => {
      const { router } = await mount();
      const next = new Promise<string>(() => {});
      await router.navigate("/items/2?tab=b", {
        loaders: [[ItemLoader, next]],
        handles: [[Titles, ["Item two"]]],
        transition: false,
      });
      await settle();
      // Urgent: the destination's skeleton is on screen with its URL.
      expect(text("skeleton")).toBe("skeleton");
      expect(text("header")).toBe(TWO);

      await open();
      expect(text("menu")).toBe(TWO);
    });
  },
);
