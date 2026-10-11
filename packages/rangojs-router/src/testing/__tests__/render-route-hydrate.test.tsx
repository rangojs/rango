// @vitest-environment happy-dom
import { Suspense, use, useEffect, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  configure,
  fireEvent,
  type RenderOptions,
} from "@testing-library/react";
import {
  createLocationState,
  useHandle,
  useLocationState,
  useParams,
} from "../../client.js";
import { createHandle } from "../../index.js";
import { renderRoute } from "../dom.entry.js";
import { withLocationStateKey } from "../index.js";

// Userland contract for renderRoute's `hydrate` mode: the same client tree is
// rendered to HTML without `window`/`document`, then hydrated, and React's
// recoverable errors are handed back. #992 is the feature this mode was added
// to reach: useLocationState inside a boundary that hydrates after the root.
// The mode sets the root's hydrated marker itself, so a `<Suspense>` boundary
// here is late by structure, as in production.

const GridState = withLocationStateKey(
  createLocationState<{ count: number }>(),
  "GridState",
);

type Pass = "server" | "client";
const currentPass = (): Pass =>
  typeof window === "undefined" ? "server" : "client";

afterEach(() => {
  cleanup();
  configure({ reactStrictMode: false });
  vi.doUnmock("@testing-library/react");
  window.history.replaceState(null, "");
});

function Env() {
  return <p data-testid="env">{currentPass()}</p>;
}

describe("renderRoute: hydrate", () => {
  it("server-renders the tree, then hydrates that HTML into an interactive root", async () => {
    // Hydration adopts the server-rendered node; a client render replaces it.
    const adopted: Array<{ found: Element | null; attached: Element | null }> =
      [];
    function Counter() {
      const { id } = useParams<{ id: string }>();
      const found =
        currentPass() === "client"
          ? document.querySelector('[data-testid="counter"]')
          : null;
      const [count, setCount] = useState(0);
      return (
        <button
          data-testid="counter"
          ref={(node) => {
            if (node) adopted.push({ found, attached: node });
          }}
          onClick={() => setCount((n) => n + 1)}
        >
          {`${id}:${count}`}
        </button>
      );
    }

    const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
      [{ path: "/items/:id", Component: Counter }],
      { request: "/items/7", hydrate: true },
    );

    expect(serverHtml).toBe('<button data-testid="counter">7:0</button>');
    expect(recoverableErrors).toEqual([]);

    const button = getByTestId("counter");
    expect(adopted[0]?.found).not.toBeNull();
    expect(adopted[0]?.attached).toBe(adopted[0]?.found);
    expect(button).toBe(adopted[0]?.found);
    fireEvent.click(button);
    expect(button.textContent).toBe("7:1");
  });

  it("reports a first client render that differs from the server HTML", async () => {
    const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
      [{ path: "/", Component: Env }],
      { hydrate: true },
    );

    // The server pass has no `window`, so the branch renders its server side.
    expect(serverHtml).toBe('<p data-testid="env">server</p>');
    expect(recoverableErrors).toEqual([
      expect.stringContaining("Hydration failed"),
    ]);
    expect(getByTestId("env").textContent).toBe("client");
  });

  it.each([
    { strict: false, label: "no StrictMode" },
    { strict: true, label: "StrictMode" },
  ])(
    "#992: a reader in a Suspense boundary that hydrates after the root stays undefined, then shows the stored value ($label)",
    async ({ strict }) => {
      configure({ reactStrictMode: strict });
      let effectsAboveRan = false;
      const seen: Array<{
        pass: Pass;
        count: number | undefined;
        effectsAboveRan: boolean;
      }> = [];
      function Reader() {
        const state = useLocationState(GridState);
        seen.push({
          pass: currentPass(),
          count: state?.count,
          effectsAboveRan,
        });
        return <p data-testid="count">{state?.count ?? 0}</p>;
      }
      function Page() {
        useEffect(() => {
          effectsAboveRan = true;
        }, []);
        return (
          <Suspense fallback={null}>
            <Reader />
          </Suspense>
        );
      }

      const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
        [{ path: "/grid", Component: Page }],
        { hydrate: true, locationState: [[GridState, { count: 3 }]] },
      );

      // history.state is seeded before the server pass and must not reach it.
      expect(seen[0]).toMatchObject({ pass: "server", count: undefined });
      expect(serverHtml).toContain('<p data-testid="count">0</p>');
      expect(recoverableErrors).toEqual([]);
      const client = seen.filter((sample) => sample.pass === "client");
      // The boundary hydrated in a later pass than the tree above it.
      expect(client[0]).toEqual({
        pass: "client",
        count: undefined,
        effectsAboveRan: true,
      });
      expect(client.at(-1)?.count).toBe(3);
      expect(getByTestId("count").textContent).toBe("3");
    },
  );

  it.each([
    { strict: false, label: "no StrictMode" },
    { strict: true, label: "StrictMode" },
  ])(
    "#1035: a useHandle reader in a Suspense boundary that hydrates after a late handle update reads the values its HTML was rendered from, then the update ($label)",
    async ({ strict }) => {
      configure({ reactStrictMode: strict });
      const Notes = createHandle<string, string[]>(
        (segments) => segments.flat(),
        "__test_late_notes__",
      );
      const seen: Array<{ pass: Pass; reader: string; notes: string[] }> = [];
      function Rows({ reader }: { reader: string }) {
        const notes = useHandle(Notes);
        seen.push({ pass: currentPass(), reader, notes });
        return (
          <ul data-testid={reader}>
            {notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        );
      }
      // "above" hydrates with the root, before the late update is applied;
      // "boundary" hydrates in a later pass, after it.
      function Page() {
        return (
          <>
            <Rows reader="above" />
            <Suspense fallback={null}>
              <Rows reader="boundary" />
            </Suspense>
          </>
        );
      }
      const rows = (element: HTMLElement): (string | null)[] =>
        Array.from(element.querySelectorAll("li"), (row) => row.textContent);

      const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
        [{ path: "/notes", Component: Page }],
        {
          hydrate: true,
          handles: [[Notes, ["from-handler"]]],
          lateHandles: [[Notes, ["from-handler", "from-loader"]]],
        },
      );

      // The HTML is rendered from `handles`, in both readers.
      expect(serverHtml.match(/<li>[^<]*<\/li>/g)).toEqual([
        "<li>from-handler</li>",
        "<li>from-handler</li>",
      ]);
      expect(recoverableErrors).toEqual([]);
      // The boundary's hydrating render, after the update reached the page.
      const boundary = seen.filter(
        (sample) => sample.pass === "client" && sample.reader === "boundary",
      );
      expect(boundary[0]?.notes).toEqual(["from-handler"]);
      expect(rows(getByTestId("above"))).toEqual([
        "from-handler",
        "from-loader",
      ]);
      expect(rows(getByTestId("boundary"))).toEqual([
        "from-handler",
        "from-loader",
      ]);
    },
  );

  it("lateHandles on a mounted tree replace the handle's seed after mount", async () => {
    const Notes = createHandle<string, string[]>(
      (segments) => segments.flat(),
      "__test_late_notes_mounted__",
    );
    function Rows() {
      return <p data-testid="notes">{useHandle(Notes).join(", ")}</p>;
    }

    const { getByTestId } = await renderRoute(
      [{ path: "/", Component: Rows }],
      {
        handles: [[Notes, ["from-handler"]]],
        lateHandles: [[Notes, ["from-handler", "from-loader"]]],
      },
    );

    expect(getByTestId("notes").textContent).toBe("from-handler, from-loader");
  });

  it("sets the root's hydrated marker before a Suspense boundary hydrates, and removes it on unmount", async () => {
    const hydrated = (): boolean =>
      document.documentElement.hasAttribute("data-hydrated");
    const markedAtRender: boolean[] = [];
    function Probe() {
      if (currentPass() === "client") markedAtRender.push(hydrated());
      return <p>probe</p>;
    }
    function Page() {
      return (
        <Suspense fallback={null}>
          <Probe />
        </Suspense>
      );
    }

    const { unmount } = await renderRoute([{ path: "/", Component: Page }], {
      hydrate: true,
    });

    expect(markedAtRender[0]).toBe(true);
    unmount();
    expect(hydrated()).toBe(false);
  });

  it("content that suspends in the server pass is client-rendered and reported", async () => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((r) => (resolve = r));
    function Late() {
      return <p data-testid="late">{use(pending)}</p>;
    }
    function Page() {
      return (
        <Suspense fallback={<i data-testid="fallback">loading</i>}>
          <Late />
        </Suspense>
      );
    }

    const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
      [{ path: "/", Component: Page }],
      { hydrate: true },
    );

    expect(serverHtml).toContain('<i data-testid="fallback">loading</i>');
    expect(serverHtml).not.toContain('data-testid="late"');
    expect(recoverableErrors).toEqual([
      expect.stringContaining("Switched to client rendering"),
    ]);
    expect(getByTestId("fallback").textContent).toBe("loading");

    await act(async () => resolve("arrived"));
    expect(getByTestId("late").textContent).toBe("arrived");
  });

  it("an unguarded document read fails the server pass as in SSR, and the globals come back", async () => {
    function Title() {
      return <p>{document.title}</p>;
    }
    const mounted = document.body.childElementCount;

    await expect(
      renderRoute([{ path: "/", Component: Title }], { hydrate: true }),
    ).rejects.toThrow("document is not defined");

    expect(currentPass()).toBe("client");
    expect(document.body.childElementCount).toBe(mounted);
  });

  it("refuses to hydrate on an RTL that drops onRecoverableError", async () => {
    vi.doMock("@testing-library/react", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("@testing-library/react")>();
      return {
        ...actual,
        // The options 16.0-16.1 read; they never name the error handler.
        render: (
          ui: ReactNode,
          { container, baseElement, hydrate }: RenderOptions,
        ) => actual.render(ui, { container, baseElement, hydrate }),
      };
    });

    await expect(
      renderRoute([{ path: "/", Component: Env }], { hydrate: true }),
    ).rejects.toThrow("@testing-library/react >= 16.2.0");

    const { getByTestId } = await renderRoute([{ path: "/", Component: Env }]);
    expect(getByTestId("env").textContent).toBe("client");
  });
});
