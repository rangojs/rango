// @vitest-environment happy-dom
import { StrictMode, useState, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createLocationState, useLocationState } from "../../client.js";
import {
  initBrowserApp,
  resetBrowserAppContext,
  type BrowserAppContext,
} from "../../browser/rsc-router.js";
import { NavigationProvider } from "../../browser/react/NavigationProvider.js";
import type {
  RscBrowserDependencies,
  RscPayload,
} from "../../browser/types.js";
import { withLocationStateKey } from "../index.js";

// #992: a reader that hydrates after the root must still render the server
// snapshot (`undefined`) on that hydration pass. These cases hand-write the
// server HTML to isolate the hook; the same contract through the public
// primitive (`renderRoute({ hydrate: true })`, which produces the server HTML
// itself) is in render-route-hydrate.test.tsx.
//
// The provider is the production NavigationProvider on a document loaded by
// initBrowserApp, hydrating with `hydration={{ settled }}` as Rango does. A
// reader takes the entry's state from it (#1029). `commitEntry` does what a
// commit site without a payload does: write history, commit that entry, flush.
// `show` swaps the tree through the store, as a navigation would.

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
let app: BrowserAppContext;

/** A document load of the entry history currently holds. */
async function loadDocument(): Promise<void> {
  resetBrowserAppContext();
  const payload = {
    metadata: { pathname: "/", segments: [], matched: [], params: {} },
  } as unknown as RscPayload;
  app = await initBrowserApp({
    rscStream: new ReadableStream<Uint8Array>(),
    deps: {
      createFromReadableStream: async () => payload,
      createFromFetch: async () => payload,
      setServerCallback: () => {},
      encodeReply: async () => "",
      createTemporaryReferenceSet: () => ({}),
    } as unknown as RscBrowserDependencies,
    linkInterception: false,
  });
}

/** Without `state` the entry is committed as history holds it. */
async function commitEntry(state?: object): Promise<void> {
  await act(async () => {
    if (state) window.history.replaceState(state, "");
    app.eventController.commitLocationState(window.history.state, true);
    app.eventController.flushRouteState();
  });
}

/** Swaps the provider's tree through the store, as a navigation does. */
async function show(node: ReactNode): Promise<void> {
  await act(async () => {
    app.store.emitUpdate({
      root: node,
      metadata: app.initialPayload.metadata!,
    });
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

function provider(
  node: ReactNode,
  strict: boolean,
  hydrating: boolean,
): ReactNode {
  const routed = (
    <NavigationProvider
      store={app.store}
      eventController={app.eventController}
      bridge={app.bridge}
      initialPayload={{ root: node, metadata: app.initialPayload.metadata! }}
      hydration={hydrating ? { settled: app.documentRevealed } : undefined}
    />
  );
  return strict ? <StrictMode>{routed}</StrictMode> : routed;
}

/** The entry a document load starts on (initBrowserApp commits it). */
async function seedEntry(state: unknown): Promise<void> {
  window.history.replaceState(state, "");
  await loadDocument();
}

async function seedHydrated(state: unknown): Promise<void> {
  document.documentElement.setAttribute("data-hydrated", "");
  await seedEntry(state);
}

async function mount(node: ReactNode, strict = false): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(provider(node, strict, false));
  });
  return container;
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
    root = hydrateRoot(container, provider(node, strict, true), {
      onRecoverableError(error: unknown) {
        recoverable.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  });
  // The document is revealed, then the barrier transition applies the entry's
  // state; flush both inside act so the assertion sees the settled value.
  await act(async () => {
    await app.documentRevealed;
  });
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

      await seedHydrated({ [GridState.__rsc_ls_key]: { count: 3 }, idx: 2 });
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

      await seedHydrated({ [FlashCount.__rsc_ls_key]: { count: 3 }, idx: 4 });
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

    await seedHydrated({ [GridState.__rsc_ls_key]: { count: 4 } });
    const container = await mount(<Count />);

    expect(seen[0]).toBe(4);
    expect(container.textContent).toBe("4");
  });

  it("a flash value stays on screen after its clear, until a commit of the entry's state replaces it", async () => {
    function Flash() {
      const state = useLocationState(FlashCount);
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }
    await seedEntry({ [FlashCount.__rsc_ls_key]: { count: 2 } });
    const flashHost = await mount(<Flash />, true);
    expect(flashHost.textContent).toBe("2");
    // Cleared from the entry: a reload or a return to it shows nothing.
    expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);

    // An unrelated re-render keeps it: the clear changed history only.
    await show(<Flash />);
    expect(flashHost.textContent).toBe("2");

    await commitEntry({ [FlashCount.__rsc_ls_key]: { count: 8 } });
    expect(flashHost.textContent).toBe("8");
    expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);

    // The same message again is a new value: shown, and cleared again.
    await commitEntry({ [FlashCount.__rsc_ls_key]: { count: 8 } });
    expect(flashHost.textContent).toBe("8");
    expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);

    // The entry as history now holds it carries no flash.
    await commitEntry();
    expect(flashHost.textContent).toBe("0");
  });

  it("plain useLocationState() late-hydrates from history.state.state and follows back/forward", async () => {
    const seen: Array<string | undefined> = [];
    function Plain() {
      const state = useLocationState<{ from?: string }>();
      seen.push(state?.from);
      return <p data-testid="from">{state?.from ?? "none"}</p>;
    }

    await seedHydrated({ state: { from: "checkout" }, idx: 1 });
    const { container, recoverable } = await hydrate(
      <Plain />,
      '<p data-testid="from">none</p>',
      true,
    );

    expect(seen[0]).toBeUndefined();
    expect(recoverable).toEqual([]);
    expect(container.textContent).toBe("checkout");

    await commitEntry({ state: { from: "back" } });
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

    await seedEntry({});
    const container = await mount(<Count />);
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

    await commitEntry();
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
    await seedEntry({
      [GridState.__rsc_ls_key]: { count: 4 },
      [FlashCount.__rsc_ls_key]: { count: 7 },
    });
    const container = await mount(<Count flash={false} />);
    expect(container.textContent).toBe("4");

    await show(<Count flash />);
    expect(container.textContent).toBe("7");
    expect(seen).not.toContain("flash:4");
    // The new slot is a flash one: read once, then cleared.
    expect(window.history.state).not.toHaveProperty(FlashCount.__rsc_ls_key);

    await commitEntry({
      [GridState.__rsc_ls_key]: { count: 5 },
    });
    await show(<Count flash={false} />);
    expect(container.textContent).toBe("5");
    expect(seen).not.toContain("grid:7");
  });

  // The entry on screen is the provider's: with none there is no entry to
  // pair a value with, and history.state is not read in its place.
  it("outside a NavigationProvider a reader has no location state", async () => {
    function Count() {
      const state = useLocationState(GridState);
      const plain = useLocationState<{ from?: string }>();
      return (
        <p data-testid="count">{`${state?.count ?? 0}|${plain?.from ?? "none"}`}</p>
      );
    }
    window.history.replaceState(
      { [GridState.__rsc_ls_key]: { count: 4 }, state: { from: "list" } },
      "",
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<Count />);
    });
    expect(container.textContent).toBe("0|none");
    // The definition's own read is not a hook and needs no provider.
    expect(GridState.read()).toEqual({ count: 4 });
  });
});
