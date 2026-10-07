// @vitest-environment happy-dom
import { startTransition, use, useContext, type ReactNode } from "react";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EventController } from "../../browser/event-controller.js";
import { emitAdoption } from "../../browser/pending-fill.js";
import { NavigationStoreContext } from "../../browser/react/context.js";
import { useNavigation } from "../../browser/react/use-navigation.js";
import type { NavigationUpdate } from "../../browser/types.js";
import { renderRoute } from "../render-route.js";

// What useNavigation() reads while React holds the update of an adopted
// prefetch that waits for its fill (`prefetch: false`), through the real
// provider and the real event controller. The adoption commits in the task
// of the click: `loading` was never rendered, and the state after the commit
// reaches React inside the update's transition. Where nothing can show a
// fallback React holds that transition until the fill returns
// (browser/pending-fill.ts emitAdoption).

afterEach(cleanup);

let controller: EventController;

function Nav(): ReactNode {
  controller = useContext(NavigationStoreContext)!.eventController;
  const nav = useNavigation();
  return <i data-testid="nav">{`${nav.state}/${nav.isStreaming}`}</i>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount() {
  const { router, getByTestId } = await renderRoute(
    [{ path: "/", Component: () => <p data-testid="page">home</p> }],
    { request: "/" },
  );
  const update = (page: ReactNode): NavigationUpdate => ({
    // <Nav> keeps its place in every root: one instance reads throughout.
    root: (
      <>
        <Nav key="nav" />
        {page}
      </>
    ),
    metadata: { pathname: "/", segments: [] },
  });
  const emit = (u: NavigationUpdate) => router.store.emitUpdate(u);
  await act(async () => emit(update(<p data-testid="page">home</p>)));
  return {
    emit,
    update,
    nav: (): string | null => getByTestId("nav").textContent,
    shown: (): string | null => getByTestId("page").textContent,
  };
}

/**
 * The click of an adopted prefetch, up to its commit: the controller goes
 * through `loading` and back in one task, with a stream still open (the
 * fill). Nothing has been delivered to React when this returns.
 */
function clickAndCommit(): { end: () => void } {
  const handle = controller.startNavigation("http://localhost/next");
  const fill = handle.startStreaming();
  handle.complete(new URL("http://localhost/next"));
  return fill;
}

describe("useNavigation() while React holds an adoption that waits for a fill", () => {
  it("reads loading until the update commits, then what the commit set", async () => {
    const { emit, update, nav, shown } = await mount();
    expect(nav()).toBe("idle/false");
    const gate = deferred<string>();
    // No boundary to fall back to: React holds the transition.
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    let fill!: { end: () => void };
    await act(async () => {
      fill = clickAndCommit();
      startTransition(() => emitAdoption(() => emit(update(<Held />))));
    });
    expect(shown(), "React holds the page being left").toBe("home");
    expect(nav()).toBe("loading/true");

    await act(async () => gate.resolve("filled"));
    expect(shown()).toBe("filled");
    expect(nav(), "the fill is still streaming").toBe("idle/true");

    await act(async () => {
      fill.end();
      await tick();
    });
    expect(nav()).toBe("idle/false");
  });

  it("reads loading for no longer than the commit takes when a fallback can show", async () => {
    const { emit, update, nav, shown } = await mount();

    let fill!: { end: () => void };
    await act(async () => {
      fill = clickAndCommit();
      startTransition(() =>
        emitAdoption(() => emit(update(<p data-testid="page">fallback</p>))),
      );
    });
    expect(shown()).toBe("fallback");
    expect(nav()).toBe("idle/true");
    fill.end();
  });

  // The control: the same update handed over as any other one is.
  it("reads idle all the while without emitAdoption", async () => {
    const { emit, update, nav, shown } = await mount();
    const gate = deferred<string>();
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    let fill!: { end: () => void };
    await act(async () => {
      fill = clickAndCommit();
      startTransition(() => emit(update(<Held />)));
    });
    expect(shown()).toBe("home");
    expect(nav()).toBe("idle/false");

    await act(async () => gate.resolve("filled"));
    expect(nav()).toBe("idle/true");
    fill.end();
  });

  // A deferred unit on a page that commits in a transition: the adoption's
  // update carries a promise of the tree, which its fill resolves with the
  // first chunk (browser/partial-update.ts Fill.land). The page commits
  // once, as a plain click commits it with its response.
  it("holds an update whose root is a promise of the tree, and commits it once", async () => {
    const { emit, update, nav, shown } = await mount();
    const tree = deferred<ReactNode>();
    const commits: string[] = [];

    let fill!: { end: () => void };
    await act(async () => {
      fill = clickAndCommit();
      startTransition(() =>
        emitAdoption(() =>
          emit({
            ...update(null),
            root: tree.promise,
            onCommit: () => commits.push("adoption"),
          }),
        ),
      );
    });
    expect(shown(), "React holds the page being left").toBe("home");
    expect(nav()).toBe("loading/true");
    expect(commits).toEqual([]);

    await act(async () =>
      tree.resolve(update(<p data-testid="page">landed</p>).root as ReactNode),
    );
    expect(shown()).toBe("landed");
    expect(nav(), "the fill is still streaming").toBe("idle/true");
    expect(commits).toEqual(["adoption"]);
    fill.end();
  });

  // The fill failed, or the visitor left: another update takes the page and
  // the promise is never resolved. Nothing stays pinned to it.
  it("lets go of a held promise root when another update takes the page", async () => {
    const { emit, update, nav, shown } = await mount();
    const tree = deferred<ReactNode>();

    let fill!: { end: () => void };
    await act(async () => {
      fill = clickAndCommit();
      startTransition(() =>
        emitAdoption(() => emit({ ...update(null), root: tree.promise })),
      );
    });
    expect(nav()).toBe("loading/true");

    await act(async () => {
      fill.end();
      emit(update(<p data-testid="page">error</p>));
      await tick();
    });
    expect(shown()).toBe("error");
    expect(nav()).toBe("idle/false");
  });
});
