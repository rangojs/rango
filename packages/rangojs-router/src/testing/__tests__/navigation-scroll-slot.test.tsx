// @vitest-environment happy-dom
import { startTransition, use, type ReactNode } from "react";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNavigationTransaction } from "../../browser/navigation-transaction.js";
import { createPartialUpdater } from "../../browser/partial-update.js";
import type { NavigationUpdate } from "../../browser/types.js";
import type { ResolvedSegment } from "../../types.js";
import { renderRoute } from "../render-route.js";

// Scroll belongs to the navigation transaction. The transaction decides it
// (tx.commit), its update carries the decision, and NavigationProvider holds
// that one pending action until the React commit that follows. These tests
// pin the delivery slot through the real provider (renderRoute mounts it):
// an update with no decision neither sets the pending action nor clears it.
//
// Scar tissue: the slot used to be assigned on every update, `undefined`
// included, and a `prefetch: false` fill sent "do not scroll". React holds a
// navigation's commit when nothing can show a fallback, so whatever landed
// meanwhile cost the navigation its scroll.

const handleNavigationEnd = vi.hoisted(() => vi.fn());
vi.mock("../../browser/scroll-restoration.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../browser/scroll-restoration.js")
  >()),
  handleNavigationEnd,
}));

afterEach(() => {
  cleanup();
  handleNavigationEnd.mockReset();
});

type Scroll = NonNullable<NavigationUpdate["scroll"]>;

async function mount() {
  const { router, getByTestId } = await renderRoute(
    [{ path: "/", Component: () => <p data-testid="page">home</p> }],
    { request: "/" },
  );
  handleNavigationEnd.mockClear();
  /** An update as a navigation (with `scroll`) or anything else (without). */
  const update = (root: ReactNode, scroll?: Scroll): NavigationUpdate => ({
    root,
    metadata: { pathname: "/", segments: [] },
    ...(scroll && { scroll }),
  });
  const page = (name: string) => <p data-testid="page">{name}</p>;
  return {
    emit: (u: NavigationUpdate) => router.store.emitUpdate(u),
    update,
    page,
    shown: () => getByTestId("page").textContent,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("the pending scroll action", () => {
  it("is applied once, by the commit of the navigation's update", async () => {
    const { emit, update, page, shown } = await mount();

    await act(async () => emit(update(page("next"), { enabled: true })));

    expect(shown()).toBe("next");
    expect(handleNavigationEnd).toHaveBeenCalledTimes(1);
    expect(handleNavigationEnd).toHaveBeenCalledWith({
      restore: undefined,
      scroll: true,
      isStreaming: undefined,
    });
  });

  // (a) What a server action, an error update and a fill all look like to
  // the slot: no `scroll`.
  it.each([
    ["has no scroll key", {}],
    ["has an undefined scroll", { scroll: undefined }],
  ])(
    "survives an update that %s and lands before the navigation's commit",
    async (_label, extra) => {
      const { emit, update, page, shown } = await mount();

      await act(async () => {
        emit(update(page("next"), { enabled: true }));
        emit({ ...update(page("next, refreshed")), ...extra });
      });

      expect(shown()).toBe("next, refreshed");
      expect(handleNavigationEnd).toHaveBeenCalledTimes(1);
      expect(handleNavigationEnd).toHaveBeenCalledWith(
        expect.objectContaining({ scroll: true }),
      );
    },
  );

  it("survives while React holds the navigation's commit, and is applied when the commit happens", async () => {
    const { emit, update, page, shown } = await mount();
    const gate = deferred<string>();
    // No boundary to fall back to: React keeps the old page and holds the
    // transition, as it does for an adoption that reads a gate.
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    await act(async () => {
      startTransition(() => emit(update(<Held />, { enabled: true })));
    });
    expect(shown()).toBe("home");
    expect(handleNavigationEnd).not.toHaveBeenCalled();

    // What the fill sends: the same page completed, and nothing about scroll.
    await act(async () => {
      startTransition(() => emit(update(page("filled"))));
    });

    expect(shown()).toBe("filled");
    expect(handleNavigationEnd).toHaveBeenCalledTimes(1);
    expect(handleNavigationEnd).toHaveBeenCalledWith(
      expect.objectContaining({ scroll: true }),
    );
  });

  // (b) The old comment's worry: with nothing clearing the slot, could a
  // later update replay a navigation's scroll? No. The commit that follows
  // any update consumes it.
  it("is not replayed by a later update with no decision", async () => {
    const { emit, update, page } = await mount();

    await act(async () => emit(update(page("next"), { enabled: true })));
    expect(handleNavigationEnd).toHaveBeenCalledTimes(1);

    await act(async () => emit(update(page("after an action"))));
    await act(async () => emit(update(page("after another"))));
    expect(handleNavigationEnd).toHaveBeenCalledTimes(1);
  });

  it("is not replayed after a navigation that decided not to scroll", async () => {
    const { emit, update, page } = await mount();

    await act(async () => emit(update(page("next"), { enabled: false })));
    await act(async () => emit(update(page("after an action"))));

    expect(handleNavigationEnd).not.toHaveBeenCalled();
  });

  // (c) Two decisions before one commit: the later navigation owns the page.
  it("is the second navigation's when two land before one commit", async () => {
    const { emit, update, page, shown } = await mount();

    await act(async () => {
      emit(update(page("first"), { enabled: true }));
      emit(update(page("second"), { enabled: false }));
    });
    expect(shown()).toBe("second");
    expect(handleNavigationEnd).not.toHaveBeenCalled();

    await act(async () => {
      emit(update(page("third"), { enabled: false }));
      emit(update(page("fourth"), {}));
    });
    expect(shown()).toBe("fourth");
    expect(handleNavigationEnd).toHaveBeenCalledTimes(1);
    expect(handleNavigationEnd).toHaveBeenCalledWith(
      expect.objectContaining({ restore: undefined, scroll: undefined }),
    );
  });

  // (d) Back/forward: navigation-bridge.ts sends `{ restore: true,
  // isStreaming }` with the cached entry.
  it("restores on a traversal, and an update with no decision does not cancel the restore", async () => {
    const { emit, update, page } = await mount();
    const isStreaming = () => false;

    await act(async () =>
      emit(update(page("restored"), { restore: true, isStreaming })),
    );
    expect(handleNavigationEnd).toHaveBeenCalledTimes(1);
    expect(handleNavigationEnd).toHaveBeenCalledWith({
      restore: true,
      scroll: undefined,
      isStreaming,
    });

    handleNavigationEnd.mockClear();
    await act(async () => {
      emit(update(page("restored again"), { restore: true, isStreaming }));
      emit(update(page("restored again, refreshed")));
    });
    expect(handleNavigationEnd).toHaveBeenCalledTimes(1);
    expect(handleNavigationEnd).toHaveBeenCalledWith(
      expect.objectContaining({ restore: true }),
    );
  });
});

// The same slot, fed by the real pieces: createPartialUpdater and
// createNavigationTransaction over renderRoute's store, event controller and
// provider. The action refetch is the call refetchRoute() makes in
// browser/server-action-bridge.ts: a transaction bound `storeOnly`, mode
// "action". A store-only commit is not a navigation, so its update carries no
// scroll at all.
//
// Scar tissue: the transaction used to answer `scroll: false` for it, which
// reached the provider as "do not scroll" and replaced the pending decision
// of a navigation React had not committed yet.
describe("an action refetch and a navigation's scroll", () => {
  async function mountWithUpdater() {
    const { router, getByTestId } = await renderRoute(
      [{ path: "/", Component: () => <p data-testid="page">home</p> }],
      { request: "/" },
    );
    handleNavigationEnd.mockClear();
    const ids = router.store.getSegmentState().currentSegmentIds;
    const routeId = ids[ids.length - 1];
    const updates: NavigationUpdate[] = [];
    // What the next render shows: the updater renders the reconciled
    // segments through this.
    const trees: ReactNode[] = [];
    const updater = createPartialUpdater({
      store: router.store,
      client: {
        fetchPartial: async () => ({
          payload: {
            metadata: {
              isPartial: true,
              pathname: "/",
              matched: ids,
              diff: [routeId],
              segments: [
                {
                  id: routeId,
                  namespace: "test",
                  type: "route",
                  index: 0,
                  component: "rendered",
                  params: {},
                } as unknown as ResolvedSegment,
              ],
            },
          },
          streamComplete: Promise.resolve(),
          // The lane a prefetched navigation commits in: a transition.
          fullyPrefetched: true,
        }),
      } as any,
      onUpdate: (update) => {
        updates.push(update);
        router.store.emitUpdate(update);
      },
      renderSegments: () => trees.shift(),
    });
    const here = (): string => window.location.href;

    /** A navigation whose tree is `tree`, through a real transaction. */
    const navigate = async (
      tree: ReactNode,
      options: { scroll?: boolean } = {},
    ) => {
      trees.push(tree);
      const tx = createNavigationTransaction(
        router.store,
        router.eventController,
        here(),
        { replace: true },
      );
      await act(async () => {
        await updater(
          here(),
          [],
          false,
          tx.handle.signal,
          tx.with({ url: here(), replace: true, ...options }),
        );
      });
      tx[Symbol.dispose]();
    };

    /** refetchRoute() of server-action-bridge.ts. */
    const actionRefetch = async (tree: ReactNode) => {
      trees.push(tree);
      const tx = createNavigationTransaction(
        router.store,
        router.eventController,
        here(),
        { replace: true, skipLoadingState: true },
      );
      await act(async () => {
        await updater(
          here(),
          [],
          false,
          tx.handle.signal,
          tx.with({ url: here(), storeOnly: true }),
          { type: "action" },
        );
      });
      tx[Symbol.dispose]();
    };

    return {
      navigate,
      actionRefetch,
      updates,
      shown: () => getByTestId("page").textContent,
    };
  }

  const page = (name: string) => <p data-testid="page">{name}</p>;

  it("lands before React commits the navigation: the navigation still scrolls", async () => {
    const { navigate, actionRefetch, updates, shown } =
      await mountWithUpdater();
    const gate = deferred<string>();
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    await navigate(<Held />);
    expect(shown(), "React holds the navigation's commit").toBe("home");
    expect(updates[0].scroll).toEqual({ enabled: undefined });
    expect(handleNavigationEnd).not.toHaveBeenCalled();

    await actionRefetch(page("after the action"));

    expect(shown()).toBe("after the action");
    expect(handleNavigationEnd).toHaveBeenCalledTimes(1);
    expect(handleNavigationEnd).toHaveBeenCalledWith(
      expect.objectContaining({ restore: undefined, scroll: undefined }),
    );
    expect("scroll" in updates[1], "the action's update says nothing").toBe(
      false,
    );
  });

  it("lands after a committed navigation: it does not scroll", async () => {
    const { navigate, actionRefetch, updates, shown } =
      await mountWithUpdater();

    await navigate(page("next"));
    expect(shown()).toBe("next");
    expect(handleNavigationEnd).toHaveBeenCalledTimes(1);

    await actionRefetch(page("after the action"));
    expect(shown()).toBe("after the action");
    expect("scroll" in updates[1]).toBe(false);
    expect(handleNavigationEnd).toHaveBeenCalledTimes(1);
  });

  // The distinction: a navigation that decided not to scroll is a decision,
  // and it does replace an earlier pending one.
  it("a navigation with scroll: false still replaces a pending decision", async () => {
    const { navigate, updates, shown } = await mountWithUpdater();
    const gate = deferred<string>();
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    await navigate(<Held />);
    await navigate(page("no scroll"), { scroll: false });

    expect(updates[1].scroll).toEqual({ enabled: false });
    expect(shown()).toBe("no scroll");
    expect(handleNavigationEnd).not.toHaveBeenCalled();
  });
});
