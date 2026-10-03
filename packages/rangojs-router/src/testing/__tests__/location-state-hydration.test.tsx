// @vitest-environment happy-dom
import { StrictMode, useState, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocationState, useLocationState } from "../../client.js";
import { withLocationStateKey } from "../index.js";

// #992: a reader that hydrates after the root effect has set `data-hydrated`
// must still render the server snapshot (`undefined`) on that hydration pass.
// `hydrateRoot` with the attribute already set is that late hydration render.
// These cases hand-write the server HTML to isolate the hook; the same
// contract through the public primitive (`renderRoute({ hydrate: true })`,
// which produces the server HTML itself) is in render-route-hydrate.test.tsx.

const GridState = withLocationStateKey(
  createLocationState<{ count: number }>(),
  "GridState",
);
const FlashCount = withLocationStateKey(
  createLocationState<{ count: number }>({ flash: true }),
  "FlashCount",
);
const VersionedGrid = withLocationStateKey(
  createLocationState<{ count: number }>({ version: 2 }),
  "VersionedGrid",
);
const VersionedFlash = withLocationStateKey(
  createLocationState<{ count: number }>({ flash: true, version: 2 }),
  "VersionedFlash",
);

type CountSample = { count: number | undefined; stored: number | undefined };

let root: Root | undefined;

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

function tree(node: ReactNode, strict: boolean): ReactNode {
  return strict ? <StrictMode>{node}</StrictMode> : node;
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
      root.render(<Count />);
    });

    expect(seen[0]).toBe(4);
    expect(container.textContent).toBe("4");
  });

  it("popstate updates a persistent reader and can clear a shown flash value", async () => {
    function Persistent() {
      const state = useLocationState(GridState);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }
    seedHydrated({ [GridState.__rsc_ls_key]: { count: 4 } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<Persistent />);
    });
    expect(container.textContent).toBe("4");

    await act(async () => {
      window.history.replaceState(
        { [GridState.__rsc_ls_key]: { count: 9 } },
        "",
      );
      window.dispatchEvent(new Event("popstate"));
    });
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
      root.render(
        <StrictMode>
          <Flash />
        </StrictMode>,
      );
    });
    expect(flashHost.textContent).toBe("2");
    expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);

    await act(async () => {
      window.history.replaceState(
        { [FlashCount.__rsc_ls_key]: { count: 5 }, idx: 1 },
        "",
      );
      window.dispatchEvent(new Event("popstate"));
    });
    expect(flashHost.textContent).toBe("5");
    expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);

    await act(async () => {
      window.history.replaceState({ idx: 0 }, "");
      window.dispatchEvent(new Event("popstate"));
    });
    expect(flashHost.textContent).toBe("0");
  });

  it("__rsc_locationstate updates persistent state and does not wipe a shown flash value", async () => {
    function Persistent() {
      const state = useLocationState(GridState);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }
    seedHydrated({ [GridState.__rsc_ls_key]: { count: 1 } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<Persistent />);
    });

    await act(async () => {
      window.history.replaceState(
        { [GridState.__rsc_ls_key]: { count: 6 } },
        "",
      );
      window.dispatchEvent(new Event("__rsc_locationstate"));
    });
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
      root.render(
        <StrictMode>
          <Flash />
        </StrictMode>,
      );
    });
    expect(flashHost.textContent).toBe("2");

    await act(async () => {
      window.dispatchEvent(new Event("__rsc_locationstate"));
    });
    expect(flashHost.textContent).toBe("2");

    await act(async () => {
      window.history.replaceState(
        { [FlashCount.__rsc_ls_key]: { count: 8 } },
        "",
      );
      window.dispatchEvent(new Event("__rsc_locationstate"));
    });
    expect(flashHost.textContent).toBe("8");
    expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);
  });

  it("plain useLocationState() late-hydrates from history.state.state and follows popstate", async () => {
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

    await act(async () => {
      window.history.replaceState({ state: { from: "back" } }, "");
      window.dispatchEvent(new Event("popstate"));
    });
    expect(container.textContent).toBe("back");
  });

  it("replaceState without an event does not update a mounted reader", async () => {
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
      root.render(<Count />);
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

    await act(async () => {
      window.dispatchEvent(new Event("popstate"));
    });
    expect(container.querySelector("[data-testid='count']")?.textContent).toBe(
      "9",
    );
  });
});

describe("useLocationState version (#994)", () => {
  it("hydrates as undefined, then the client snapshot is the inner value", async () => {
    const inner = { count: 3 };
    const seen: Array<{ count: number } | undefined> = [];
    function Count() {
      const state = useLocationState(VersionedGrid);
      seen.push(state);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }

    seedHydrated({
      [VersionedGrid.__rsc_ls_key]: { __rsc_ls_env: 1, v: 2, value: inner },
      idx: 2,
    });
    const { container, recoverable } = await hydrate(
      <Count />,
      '<p data-testid="count">0</p>',
      true,
    );

    expect(seen[0]).toBeUndefined();
    expect(recoverable).toEqual([]);
    expect(seen.at(-1)).toBe(inner);
    expect(container.textContent).toBe("3");
    expect(window.history.state?.[VersionedGrid.__rsc_ls_key]).toEqual({
      __rsc_ls_env: 1,
      v: 2,
      value: inner,
    });
  });

  it("a non-hydrating mount reads the inner value, not the envelope", async () => {
    const inner = { count: 4 };
    const seen: Array<{ count: number } | undefined> = [];
    function Count() {
      const state = useLocationState(VersionedGrid);
      seen.push(state);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }

    seedHydrated({
      [VersionedGrid.__rsc_ls_key]: { __rsc_ls_env: 1, v: 2, value: inner },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<Count />);
    });

    expect(seen[0]).toBe(inner);
    expect(container.textContent).toBe("4");
  });

  it("popstate and __rsc_locationstate deliver the inner value, or undefined on mismatch", async () => {
    function Count() {
      const state = useLocationState(VersionedGrid);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }
    const first = { count: 4 };
    seedHydrated({
      [VersionedGrid.__rsc_ls_key]: { __rsc_ls_env: 1, v: 2, value: first },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<Count />);
    });
    expect(container.textContent).toBe("4");

    const next = { count: 9 };
    await act(async () => {
      window.history.replaceState(
        {
          [VersionedGrid.__rsc_ls_key]: { __rsc_ls_env: 1, v: 2, value: next },
        },
        "",
      );
      window.dispatchEvent(new Event("popstate"));
    });
    expect(container.textContent).toBe("9");

    await act(async () => {
      window.history.replaceState(
        { [VersionedGrid.__rsc_ls_key]: { count: 1 } },
        "",
      );
      window.dispatchEvent(new Event("__rsc_locationstate"));
    });
    expect(container.textContent).toBe("0");
  });

  it("versioned flash shows the inner value and clears the envelope after paint", async () => {
    const inner = { count: 2 };
    const seen: Array<{ count: number } | undefined> = [];
    function Flash() {
      const state = useLocationState(VersionedFlash);
      seen.push(state);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }

    seedHydrated({
      [VersionedFlash.__rsc_ls_key]: { __rsc_ls_env: 1, v: 2, value: inner },
      idx: 1,
    });
    const { container, recoverable } = await hydrate(
      <Flash />,
      '<p data-testid="count">0</p>',
      true,
    );

    expect(seen[0]).toBeUndefined();
    expect(recoverable).toEqual([]);
    expect(seen.at(-1)).toBe(inner);
    expect(container.textContent).toBe("2");
    expect(window.history.state).not.toHaveProperty(
      VersionedFlash.__rsc_ls_key,
    );
    expect(window.history.state).toMatchObject({ idx: 1 });

    const again = { count: 5 };
    await act(async () => {
      window.history.replaceState(
        {
          [VersionedFlash.__rsc_ls_key]: {
            __rsc_ls_env: 1,
            v: 2,
            value: again,
          },
          idx: 1,
        },
        "",
      );
      window.dispatchEvent(new Event("popstate"));
    });
    expect(container.textContent).toBe("5");
    expect(window.history.state).not.toHaveProperty(
      VersionedFlash.__rsc_ls_key,
    );
  });
});

// #994: a validate that throws reads `undefined`. Thrown out of render it
// fails the mount; thrown out of the popstate / __rsc_locationstate listeners
// it leaves the reader on the previous entry's value.
describe("useLocationState with a validate that throws (#994)", () => {
  const ThrowingGrid = withLocationStateKey(
    createLocationState<{ count: number }>({
      validate: (value): value is { count: number } => {
        if ((value as { poison?: boolean }).poison) throw new Error("poison");
        return typeof (value as { count?: unknown }).count === "number";
      },
    }),
    "ThrowingGrid",
  );

  function Count() {
    const state = useLocationState(ThrowingGrid);
    return <p data-testid="count">{state?.count ?? 0}</p>;
  }

  it("mounting on a slot whose validate throws renders undefined", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    seedHydrated({ [ThrowingGrid.__rsc_ls_key]: { poison: true } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<Count />);
    });

    expect(container.textContent).toBe("0");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain(ThrowingGrid.__rsc_ls_key);
    error.mockRestore();
  });

  it.each(["popstate", "__rsc_locationstate"])(
    "%s to a slot whose validate throws drops the previous entry's value",
    async (event) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      seedHydrated({ [ThrowingGrid.__rsc_ls_key]: { count: 4 } });
      const container = document.createElement("div");
      document.body.appendChild(container);
      await act(async () => {
        root = createRoot(container);
        root.render(<Count />);
      });
      expect(container.textContent).toBe("4");

      await act(async () => {
        window.history.replaceState(
          { [ThrowingGrid.__rsc_ls_key]: { poison: true } },
          "",
        );
        window.dispatchEvent(new Event(event));
      });
      expect(container.textContent).toBe("0");
      error.mockRestore();
    },
  );
});
