// @vitest-environment happy-dom
import { StrictMode, useState, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocationState, useLocationState } from "../../client.js";
import {
  createEventController,
  type EventController,
} from "../../browser/event-controller.js";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "../../browser/react/context.js";
import { withLocationStateKey } from "../index.js";

// #992: a reader that hydrates after the root effect has set `data-hydrated`
// must still render the server snapshot (`undefined`) on that hydration pass.
// `hydrateRoot` with the attribute already set is that late hydration render.
// These cases hand-write the server HTML to isolate the hook; the same
// contract through the public primitive (`renderRoute({ hydrate: true })`,
// which produces the server HTML itself) is in render-route-hydrate.test.tsx.
//
// A reader hears about the entry's state from its router's event controller
// (#1029), so the trees below get one through NavigationStoreContext, and
// `commitEntry` does what a commit site does: write history, commit, flush.

const GridState = withLocationStateKey(
  createLocationState<{ count: number }>(),
  "GridState",
);
const FlashCount = withLocationStateKey(
  createLocationState<{ count: number }>({ flash: true }),
  "FlashCount",
);

type CountSample = { count: number | undefined; stored: number | undefined };

let root: Root | undefined;
let controller: EventController;

beforeEach(() => {
  controller = createEventController({
    initialLocation: new URL("http://localhost/"),
  });
});

/**
 * `traversal`: back/forward to the entry (the router's popstate commit).
 * Without `state` the entry is committed as it stands.
 */
async function commitEntry(traversal: boolean, state?: object): Promise<void> {
  await act(async () => {
    if (state) window.history.replaceState(state, "");
    controller.commitLocationState(traversal);
    controller.flushRouteState();
  });
}

afterEach(async () => {
  if (root) {
    const current = root;
    root = undefined;
    await act(async () => {
      current.unmount();
    });
  }
  cleanup();
  document.documentElement.removeAttribute("data-hydrated");
  window.history.replaceState(null, "");
  document.body.replaceChildren();
});

function tree(node: ReactNode, strict = false): ReactNode {
  const routed = (
    <NavigationStoreContext.Provider
      value={{ eventController: controller } as NavigationStoreContextValue}
    >
      {node}
    </NavigationStoreContext.Provider>
  );
  return strict ? <StrictMode>{routed}</StrictMode> : routed;
}

function seedHydrated(state: unknown): void {
  document.documentElement.setAttribute("data-hydrated", "");
  window.history.replaceState(state, "");
}

async function hydrate(
  node: ReactNode,
  serverHtml: string,
  strict: boolean,
): Promise<{ container: HTMLDivElement; recoverable: string[] }> {
  const container = document.createElement("div");
  container.innerHTML = serverHtml;
  document.body.appendChild(container);
  const recoverable: string[] = [];
  await act(async () => {
    root = hydrateRoot(container, tree(node, strict), {
      onRecoverableError(error: unknown) {
        recoverable.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  });
  // The client snapshot is applied from a passive effect. Flush that update
  // inside act so the assertion sees the settled value, not the server paint.
  await act(async () => {});
  return { container, recoverable };
}

describe("useLocationState late hydration (#992)", () => {
  it.each([
    { strict: true, label: "StrictMode" },
    { strict: false, label: "no StrictMode" },
  ])(
    "hydrating persistent reader stays undefined then shows the stored value ($label)",
    async ({ strict }) => {
      const seen: CountSample[] = [];
      function Count() {
        const state = useLocationState(GridState);
        seen.push({
          count: state?.count,
          stored: window.history.state?.[GridState.__rsc_ls_key]?.count as
            | number
            | undefined,
        });
        return <p data-testid="count">{state?.count ?? 0}</p>;
      }

      seedHydrated({ [GridState.__rsc_ls_key]: { count: 3 }, idx: 2 });
      const { container, recoverable } = await hydrate(
        <Count />,
        '<p data-testid="count">0</p>',
        strict,
      );

      // The bug reads history in the hydration render once data-hydrated is set.
      expect(seen[0]?.stored).toBe(3);
      expect(seen[0]?.count).toBeUndefined();
      expect(recoverable).toEqual([]);
      expect(seen.at(-1)?.count).toBe(3);
      expect(
        container.querySelector("[data-testid='count']")?.textContent,
      ).toBe("3");
      expect(window.history.state).toMatchObject({
        [GridState.__rsc_ls_key]: { count: 3 },
        idx: 2,
      });
    },
  );

  it.each([
    { strict: true, label: "StrictMode" },
    { strict: false, label: "no StrictMode" },
  ])(
    "hydrating flash reader stays undefined, then keeps the value after the clear ($label)",
    async ({ strict }) => {
      const seen: CountSample[] = [];
      function Count() {
        const state = useLocationState(FlashCount);
        seen.push({
          count: state?.count,
          stored: window.history.state?.[FlashCount.__rsc_ls_key]?.count as
            | number
            | undefined,
        });
        return <p data-testid="count">{state?.count ?? 0}</p>;
      }

      seedHydrated({ [FlashCount.__rsc_ls_key]: { count: 3 }, idx: 4 });
      const { container, recoverable } = await hydrate(
        <Count />,
        '<p data-testid="count">0</p>',
        strict,
      );

      expect(seen[0]?.stored).toBe(3);
      expect(seen[0]?.count).toBeUndefined();
      expect(recoverable).toEqual([]);
      // StrictMode runs the clear before the second effect pass. A re-read
      // there would paint 0 and drop the captured flash value.
      expect(seen.at(-1)?.count).toBe(3);
      expect(
        container.querySelector("[data-testid='count']")?.textContent,
      ).toBe("3");
      expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);
      expect(window.history.state).toMatchObject({ idx: 4 });
    },
  );

  it("a non-hydrating mount reads the stored value on the first render", async () => {
    const seen: Array<number | undefined> = [];
    function Count() {
      const state = useLocationState(GridState);
      seen.push(state?.count);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }

    seedHydrated({ [GridState.__rsc_ls_key]: { count: 4 } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(tree(<Count />));
    });

    expect(seen[0]).toBe(4);
    expect(container.textContent).toBe("4");
  });

  it("back/forward updates a persistent reader and can clear a shown flash value", async () => {
    function Persistent() {
      const state = useLocationState(GridState);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }
    seedHydrated({ [GridState.__rsc_ls_key]: { count: 4 } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(tree(<Persistent />));
    });
    expect(container.textContent).toBe("4");

    await commitEntry(true, { [GridState.__rsc_ls_key]: { count: 9 } });
    expect(container.textContent).toBe("9");

    await act(async () => {
      root?.unmount();
    });
    root = undefined;
    container.remove();

    function Flash() {
      const state = useLocationState(FlashCount);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }
    seedHydrated({ [FlashCount.__rsc_ls_key]: { count: 2 }, idx: 1 });
    const flashHost = document.createElement("div");
    document.body.appendChild(flashHost);
    await act(async () => {
      root = createRoot(flashHost);
      root.render(tree(<Flash />, true));
    });
    expect(flashHost.textContent).toBe("2");
    expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);

    await commitEntry(true, {
      [FlashCount.__rsc_ls_key]: { count: 5 },
      idx: 1,
    });
    expect(flashHost.textContent).toBe("5");
    expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);

    await commitEntry(true, { idx: 0 });
    expect(flashHost.textContent).toBe("0");
  });

  it("a commit on the current entry updates persistent state and does not wipe a shown flash value", async () => {
    function Persistent() {
      const state = useLocationState(GridState);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }
    seedHydrated({ [GridState.__rsc_ls_key]: { count: 1 } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(tree(<Persistent />));
    });

    await commitEntry(false, { [GridState.__rsc_ls_key]: { count: 6 } });
    expect(container.textContent).toBe("6");

    await act(async () => {
      root?.unmount();
    });
    root = undefined;
    container.remove();

    function Flash() {
      const state = useLocationState(FlashCount);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }
    seedHydrated({ [FlashCount.__rsc_ls_key]: { count: 2 } });
    const flashHost = document.createElement("div");
    document.body.appendChild(flashHost);
    await act(async () => {
      root = createRoot(flashHost);
      root.render(tree(<Flash />, true));
    });
    expect(flashHost.textContent).toBe("2");

    // The slot is empty because this reader cleared it after paint.
    await commitEntry(false);
    expect(flashHost.textContent).toBe("2");

    await commitEntry(false, { [FlashCount.__rsc_ls_key]: { count: 8 } });
    expect(flashHost.textContent).toBe("8");
    expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);
  });

  it("plain useLocationState() late-hydrates from history.state.state and follows back/forward", async () => {
    const seen: Array<string | undefined> = [];
    function Plain() {
      const state = useLocationState<{ from?: string }>();
      seen.push(state?.from);
      return <p data-testid="from">{state?.from ?? "none"}</p>;
    }

    seedHydrated({ state: { from: "checkout" }, idx: 1 });
    const { container, recoverable } = await hydrate(
      <Plain />,
      '<p data-testid="from">none</p>',
      true,
    );

    expect(seen[0]).toBeUndefined();
    expect(recoverable).toEqual([]);
    expect(container.textContent).toBe("checkout");

    await commitEntry(true, { state: { from: "back" } });
    expect(container.textContent).toBe("back");
  });

  it("replaceState without a commit does not update a mounted reader", async () => {
    function Count() {
      const state = useLocationState(GridState);
      const [, bump] = useState(0);
      return (
        <p>
          <span data-testid="count">{state?.count ?? 0}</span>
          <button type="button" onClick={() => bump((n) => n + 1)}>
            bump
          </button>
        </p>
      );
    }

    window.history.replaceState({}, "");
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(tree(<Count />));
    });
    expect(container.querySelector("[data-testid='count']")?.textContent).toBe(
      "0",
    );

    await act(async () => {
      window.history.replaceState(
        { [GridState.__rsc_ls_key]: { count: 9 } },
        "",
      );
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("[data-testid='count']")?.textContent).toBe(
      "0",
    );

    await commitEntry(true);
    expect(container.querySelector("[data-testid='count']")?.textContent).toBe(
      "9",
    );
  });

  it("a reader handed another definition reads that definition's slot, never the previous one's value", async () => {
    const seen: string[] = [];
    function Count({ flash }: { flash: boolean }) {
      const state = useLocationState(flash ? FlashCount : GridState);
      seen.push(`${flash ? "flash" : "grid"}:${state?.count ?? "none"}`);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }
    window.history.replaceState(
      {
        [GridState.__rsc_ls_key]: { count: 4 },
        [FlashCount.__rsc_ls_key]: { count: 7 },
      },
      "",
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(tree(<Count flash={false} />));
    });
    expect(container.textContent).toBe("4");

    await act(async () => root?.render(tree(<Count flash />)));
    expect(container.textContent).toBe("7");
    expect(seen).not.toContain("flash:4");
    // The new slot is a flash one: read once, then cleared.
    expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);

    await commitEntry(false, {
      [GridState.__rsc_ls_key]: { count: 5 },
    });
    await act(async () => root?.render(tree(<Count flash={false} />)));
    expect(container.textContent).toBe("5");
    expect(seen).not.toContain("grid:7");
  });

  it("outside a NavigationProvider a reader takes the entry's state at mount and hears no commit", async () => {
    function Count() {
      const state = useLocationState(GridState);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }
    window.history.replaceState({ [GridState.__rsc_ls_key]: { count: 4 } }, "");
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<Count />);
    });
    expect(container.textContent).toBe("4");

    // No router, so nothing commits an entry for it.
    await commitEntry(true, { [GridState.__rsc_ls_key]: { count: 9 } });
    expect(container.textContent).toBe("4");
  });
});
