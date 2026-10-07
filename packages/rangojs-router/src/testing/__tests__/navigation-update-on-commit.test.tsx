// @vitest-environment happy-dom
import { startTransition, use, type ReactNode } from "react";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NavigationUpdate } from "../../browser/types.js";
import { renderRoute } from "../render-route.js";

// NavigationUpdate.onCommit, through the real provider (renderRoute mounts
// it). The fill of a `prefetch: false` unit resolves the unit's gate from it
// (browser/partial-update.ts runFill): the gate must stay pending until React
// has committed the fill's tree, so the unit is revealed by a Suspense retry,
// and it must resolve in every case, or the unit never shows.

afterEach(cleanup);

async function mount() {
  const { router, getByTestId } = await renderRoute(
    [{ path: "/", Component: () => <p data-testid="page">home</p> }],
    { request: "/" },
  );
  const shown = (): string | null => getByTestId("page").textContent;
  /** What the page showed each time an update heard of its commit. */
  const heard: string[] = [];
  const update = (root: ReactNode, name?: string): NavigationUpdate => ({
    root,
    metadata: { pathname: "/", segments: [] },
    ...(name && { onCommit: () => heard.push(`${name} at ${shown()}`) }),
  });
  return {
    emit: (u: NavigationUpdate) => router.store.emitUpdate(u),
    update,
    page: (name: string) => <p data-testid="page">{name}</p>,
    shown,
    heard,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("NavigationUpdate.onCommit", () => {
  it("is called once, after React has committed the update's tree", async () => {
    const { emit, update, page, heard } = await mount();

    await act(async () => emit(update(page("one"), "one")));
    expect(heard).toEqual(["one at one"]);

    await act(async () => emit(update(page("two"))));
    expect(heard, "a later commit does not call it again").toEqual([
      "one at one",
    ]);
  });

  it("waits while React holds the update's commit", async () => {
    const { emit, update, shown, heard } = await mount();
    const gate = deferred<string>();
    // No boundary to fall back to: React holds the transition.
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    await act(async () => {
      startTransition(() => emit(update(<Held />, "held")));
    });
    expect(shown()).toBe("home");
    expect(heard).toEqual([]);

    await act(async () => gate.resolve("released"));
    expect(heard).toEqual(["held at released"]);
  });

  it("is called by the commit that supersedes it while React holds it", async () => {
    const { emit, update, page, shown, heard } = await mount();
    const gate = deferred<string>();
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    await act(async () => {
      emit(update(page("earlier"), "earlier"));
    });
    await act(async () => {
      startTransition(() => emit(update(<Held />, "held")));
    });
    expect(heard).toEqual(["earlier at earlier"]);

    // An urgent update lands while the transition is held: React will never
    // commit the held tree.
    await act(async () => emit(update(page("urgent"))));
    expect(shown()).toBe("urgent");
    expect(heard).toEqual(["earlier at earlier", "held at urgent"]);
  });

  // React commits only the last of several updates it batches: the ones it
  // skipped must still hear, or a unit's gate would stay pending forever.
  it("is called by a later update's commit when its own never happens", async () => {
    const { emit, update, page, shown, heard } = await mount();

    await act(async () => {
      emit(update(page("skipped"), "skipped"));
      emit(update(page("last"), "last"));
    });

    expect(shown()).toBe("last");
    expect(heard).toEqual(["skipped at last", "last at last"]);
  });

  it("keeps a later update waiting while only an earlier one has committed", async () => {
    const { emit, update, page, shown, heard } = await mount();
    const gate = deferred<string>();
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    await act(async () => {
      emit(update(page("earlier"), "earlier"));
      startTransition(() => emit(update(<Held />, "later")));
    });
    expect(shown()).toBe("earlier");
    expect(heard).toEqual(["earlier at earlier"]);

    await act(async () => gate.resolve("released"));
    expect(heard).toEqual(["earlier at earlier", "later at released"]);
  });
});
