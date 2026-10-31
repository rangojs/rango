// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  Suspense,
  useLayoutEffect,
  useState,
  ViewTransition,
  type ReactNode,
} from "react";
import {
  Outlet,
  useAction,
  useNavigation,
  useParams,
  usePathname,
} from "../../client.js";
import { useLoader } from "../../use-loader.js";
import type { TrackedActionState } from "../../browser/types.js";
import type { ActionHandle } from "../../browser/event-controller.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../dom.entry.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

// Consumer contract (rango-t223, owner decision rango-t219-q3): useAction()'s
// result, error and revalidationError stay after the call settles, until the
// same action is called again. The next call reads loading with nothing; an
// aborted latest call reads idle with nothing. Every reader agrees, one that
// mounts after the settle included, and a navigation, a refresh or a Back
// changes nothing it reads.
//
// renderRoute runs no server action (its fidelity contract), so these tests
// drive the action lifecycle through router.eventController, the controller
// the server-action bridge drives (startAction, startStreaming, complete,
// fail, abortAllActions). The browser proof is e2e/action-persists.test.ts
// in the router test-app and tests/cloudflare-basic.

const SAVE = "src/cart.ts#save";
/** Another file's action with the same export name. */
const WISHLIST_SAVE = "src/wishlist.ts#save";
/** The function form: an imported "use server" export carries its $$id. */
const save = Object.assign(async () => undefined, { $$id: SAVE });

const ItemLoader = { __brand: "loader" } as unknown as LoaderDefinition<string>;

const label = (value: unknown): string =>
  (value as { name?: string } | null)?.name ?? "-";
const message = (error: unknown): string =>
  error instanceof Error ? error.message : "-";
const describeState = (s: TrackedActionState): string =>
  `${s.state} ${label(s.result)} ${message(s.error)} ${message(s.revalidationError)}`;

/** Every commit of the layout's reader: "<action> | <nav state> <pathname>". */
let chrome: string[];
/** Every commit of the layout's error selector. */
let errors: string[];
/** Every commit of the page's reader by export name: "<page> <result>". */
let pages: string[];
let stub: ReturnType<typeof installViewTransitionStub> | undefined;

/** A full-state reader beside useNavigation() and usePathname(). */
function Chrome(): ReactNode {
  const action = useAction(save);
  const nav = useNavigation((n) => n.state);
  const pathname = usePathname();
  const shown = describeState(action);
  useLayoutEffect(() => {
    chrome.push(`${shown} | ${nav} ${pathname}`);
  });
  return <p data-testid="chrome">{shown}</p>;
}

/** A selector reader. */
function ErrorLine(): ReactNode {
  const error = useAction(save, (s) => message(s.error));
  useLayoutEffect(() => {
    errors.push(error);
  });
  return <p data-testid="error">{error}</p>;
}

/** A full-state reader mounted on demand. */
function LateReader(): ReactNode {
  return <p data-testid="late">{describeState(useAction(save))}</p>;
}

function Shell(): ReactNode {
  const [late, setLate] = useState(false);
  return (
    <div>
      <Chrome />
      <ErrorLine />
      <button data-testid="show-late" onClick={() => setLate(true)}>
        show
      </button>
      {late && <LateReader />}
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        <Outlet />
      </Suspense>
    </div>
  );
}

/** A reader by export name, mounted with each page. */
function PageReader({ id }: { id: string }): ReactNode {
  const result = useAction("save", (s) => label(s.result));
  useLayoutEffect(() => {
    pages.push(`${id} ${result}`);
  });
  return <p data-testid="page-reader">{result}</p>;
}

function Item(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const { data } = useLoader(ItemLoader);
  return (
    <ViewTransition key={id} enter={{ push: "page", default: "none" }}>
      <div>
        <p data-testid="page">{`${id}:${data}`}</p>
        <PageReader key={id} id={id!} />
      </div>
    </ViewTransition>
  );
}

async function render(transition: boolean) {
  return renderRoute(
    [
      { path: "/items", Component: Shell },
      {
        path: "/items/:id",
        Component: Item,
        ...(transition && { transition: {} }),
      },
    ],
    { request: "/items/1", loaders: [[ItemLoader, "one"]] },
  );
}

type Router = Awaited<ReturnType<typeof render>>["router"];

/** Past the controller's 100 ms cleanup of a settled call. */
const pastSettleWindow = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));

/** `step`, then the task the controller notifies readers in. */
async function step(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function start(
  router: Router,
  actionId: string,
  args: unknown[] = [],
): Promise<ActionHandle> {
  let handle!: ActionHandle;
  await step(() => {
    handle = router.eventController.startAction(actionId, args);
  });
  return handle;
}

/** A call of `actionId` that returns `name` and is past its settle window. */
async function settled(
  router: Router,
  name: string,
  actionId = SAVE,
): Promise<void> {
  const call = await start(router, actionId, [name]);
  await step(() => call.complete({ name }));
  await pastSettleWindow();
}

function deferred(): {
  promise: Promise<string>;
  resolve: (v: string) => void;
} {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { promise, resolve };
}

/** Consecutive duplicates dropped: what a reader showed, commit by commit. */
const distinct = (values: string[]): string[] =>
  values.filter((value, i) => i === 0 || values[i - 1] !== value);
const actionOf = (frame: string): string => frame.split(" | ")[0]!;

beforeEach(() => {
  chrome = [];
  errors = [];
  pages = [];
  stub = installViewTransitionStub();
});

afterEach(() => {
  cleanup();
  stub?.uninstall();
});

describe("renderRoute: useAction() keeps a settled call until the action's next call", () => {
  it("a call's result stays after it settles; the next call reads loading with nothing, then its own result", async () => {
    const { router, getByTestId } = await render(false);

    const one = await start(router, SAVE, ["one"]);
    let stream!: ReturnType<ActionHandle["startStreaming"]>;
    await step(() => (stream = one.startStreaming()));
    await step(() => {
      stream.end();
      one.complete({ name: "one" });
    });
    await pastSettleWindow();
    expect(getByTestId("chrome").textContent).toBe("idle one - -");

    const two = await start(router, SAVE, ["two"]);
    expect(getByTestId("chrome").textContent).toBe("loading - - -");
    await step(() => two.complete({ name: "two" }));
    await pastSettleWindow();

    expect(distinct(chrome.map(actionOf))).toEqual([
      "idle - - -",
      "loading - - -",
      "streaming - - -",
      "idle one - -",
      "loading - - -",
      "idle two - -",
    ]);
  });

  it("a call that fails keeps its error; a call whose revalidation fails keeps its revalidationError", async () => {
    const { router, getByTestId } = await render(false);

    const one = await start(router, SAVE, ["one"]);
    await step(() => one.fail(new Error("out of stock")));
    await pastSettleWindow();
    expect(getByTestId("chrome").textContent).toBe("idle - out of stock -");
    expect(getByTestId("error").textContent).toBe("out of stock");

    const two = await start(router, SAVE, ["two"]);
    await step(() =>
      two.complete({ name: "two" }, new Error("stock loader failed")),
    );
    await pastSettleWindow();
    expect(getByTestId("chrome").textContent).toBe(
      "idle two - stock loader failed",
    );

    expect(distinct(chrome.map(actionOf))).toEqual([
      "idle - - -",
      "loading - - -",
      "idle - out of stock -",
      "loading - - -",
      "idle two - stock loader failed",
    ]);
    expect(distinct(errors)).toEqual(["-", "out of stock", "-"]);
  });

  it("a reader that mounts after the call settled reads it", async () => {
    const { router, getByTestId } = await render(false);
    await settled(router, "one");

    fireEvent.click(getByTestId("show-late"));
    expect(getByTestId("late").textContent).toBe("idle one - -");
  });

  it("an aborted latest call reads idle with nothing; the earlier call's result does not come back", async () => {
    const { router, getByTestId } = await render(false);
    await settled(router, "one");

    const two = await start(router, SAVE, ["two"]);
    await step(() => {
      router.eventController.abortAllActions();
      two[Symbol.dispose]();
    });
    await pastSettleWindow();
    expect(getByTestId("chrome").textContent).toBe("idle - - -");

    expect(distinct(chrome.map(actionOf))).toEqual([
      "idle - - -",
      "loading - - -",
      "idle one - -",
      "loading - - -",
      "idle - - -",
    ]);
  });

  it("the later of two calls keeps its result when the earlier one settles after its settle window", async () => {
    const { router, getByTestId } = await render(false);

    const first = await start(router, SAVE, ["first"]);
    const second = await start(router, SAVE, ["second"]);
    await step(() => second.complete({ name: "second" }));
    await pastSettleWindow();
    await step(() => first.fail(new Error("out of stock")));
    await pastSettleWindow();
    expect(getByTestId("chrome").textContent).toBe("idle second - -");

    fireEvent.click(getByTestId("show-late"));
    expect(getByTestId("late").textContent).toBe("idle second - -");
    expect(distinct(chrome.map(actionOf))).toEqual([
      "idle - - -",
      "loading - - -",
      "idle second - -",
    ]);
  });
});

describe("renderRoute: useAction() by export name follows the latest call of any action with that name", () => {
  it("a reader by name reads the latest call; a reader by id keeps its own action's last call", async () => {
    function Readers(): ReactNode {
      const cart = useAction(save, (s) => label(s.result));
      const byName = useAction("save", (s) => `${s.state} ${label(s.result)}`);
      const wishlist = useAction(WISHLIST_SAVE, (s) => label(s.result));
      return <p data-testid="readers">{`${cart} | ${byName} | ${wishlist}`}</p>;
    }
    const { router, getByTestId } = await renderRoute(
      [{ path: "/cart", Component: Readers }],
      { request: "/cart" },
    );
    const readers = () => getByTestId("readers").textContent;

    await settled(router, "cart");
    expect(readers()).toBe("cart | idle cart | -");

    // The other file's call: the reader by name follows it, and reads idle
    // with nothing once it is aborted.
    const aborted = await start(router, WISHLIST_SAVE, ["aborted"]);
    expect(readers()).toBe("cart | loading - | -");
    await step(() => {
      router.eventController.abortAllActions();
      aborted[Symbol.dispose]();
    });
    await pastSettleWindow();
    expect(readers()).toBe("cart | idle - | -");

    await settled(router, "wishlist", WISHLIST_SAVE);
    expect(readers()).toBe("cart | idle wishlist | wishlist");

    const next = await start(router, SAVE, ["next"]);
    expect(readers()).toBe("- | loading - | wishlist");
    await step(() => next.complete({ name: "next" }));
    await pastSettleWindow();
    expect(readers()).toBe("next | idle next | wishlist");
  });

  it("an earlier call of one file settling after a later call of the other: the reader by name keeps the later call", async () => {
    function Readers(): ReactNode {
      const cart = useAction(save, (s) => `${s.state} ${label(s.result)}`);
      const byName = useAction("save", (s) => `${s.state} ${label(s.result)}`);
      return <p data-testid="readers">{`${cart} | ${byName}`}</p>;
    }
    const { router, getByTestId } = await renderRoute(
      [{ path: "/cart", Component: Readers }],
      { request: "/cart" },
    );
    const readers = () => getByTestId("readers").textContent;

    const cart = await start(router, SAVE, ["cart"]);
    const wishlist = await start(router, WISHLIST_SAVE, ["wishlist"]);
    await step(() => wishlist.complete({ name: "wishlist" }));
    await pastSettleWindow();
    expect(readers()).toBe("loading - | idle wishlist");
    await step(() => cart.complete({ name: "cart" }));
    await pastSettleWindow();
    expect(readers()).toBe("idle cart | idle wishlist");
  });
});

describe("renderRoute: a settled call stays through navigations", () => {
  const variants = [
    { name: "no transition()", transition: false, held: false },
    {
      name: "transition(), the page held, with a view transition",
      transition: true,
      held: true,
    },
    {
      name: "transition() with transition: false on the navigation",
      transition: true,
      held: false,
    },
  ] as const;

  for (const variant of variants) {
    it(`${variant.name}: a navigation, a refresh and a Back change nothing a reader reads, and a page's reader that mounts reads the call`, async () => {
      const { router, getByTestId } = await render(variant.transition);
      await settled(router, "one");
      const from = chrome.length;

      const two = deferred();
      await act(async () => {
        await router.navigate("/items/2", {
          // Pushes an entry, so Back restores the first page from its own.
          state: { from: "items" },
          loaders: [[ItemLoader, variant.held ? two.promise : "two"]],
          ...(variant.transition &&
            !variant.held && { transition: false as const }),
        });
      });
      if (variant.held) {
        // React holds the destination: the page being left, loading.
        expect(getByTestId("page").textContent).toBe("1:one");
        await act(async () => {
          two.resolve("two");
          await two.promise;
        });
      }
      await waitFor(() =>
        expect(getByTestId("page").textContent).toBe("2:two"),
      );
      await act(() => router.refresh());
      await pastSettleWindow();

      // Back: the first page is restored from its history entry.
      await act(async () => {
        window.history.back();
      });
      await waitFor(() =>
        expect(getByTestId("page").textContent).toBe("1:one"),
      );
      await pastSettleWindow();

      expect(
        distinct(chrome.slice(from).map(actionOf)),
        "the layout's reader through the navigations",
      ).toEqual(["idle one - -"]);
      if (variant.held) {
        expect(
          chrome.some((frame) => frame.endsWith("| loading /items/1")),
          "useNavigation() read loading while the page was held",
        ).toBe(true);
      }
      expect(distinct(errors)).toEqual(["-"]);
      expect(
        distinct(pages),
        "each page's reader, as each page mounts",
      ).toEqual(["1 -", "1 one", "2 one", "1 one"]);
      if (variant.held) {
        expect(stub!.types()).toContainEqual(["push", "navigation"]);
      }
    });
  }
});
