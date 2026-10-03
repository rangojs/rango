// @vitest-environment happy-dom
import {
  Suspense,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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
  useLocationState,
  useParams,
} from "../../client.js";
import { renderRoute } from "../dom.entry.js";
import { withLocationStateKey } from "../index.js";

// Userland contract for renderRoute's `hydrate` mode: the same client tree is
// rendered to HTML without `window`/`document`, then hydrated, and React's
// recoverable errors are handed back. #992 is the feature this mode was added
// to reach: useLocationState inside a boundary that hydrates after the root.

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
  document.documentElement.removeAttribute("data-hydrated");
  window.history.replaceState(null, "");
});

const subscribeNever = (): (() => void) => () => {};

function Env() {
  return <p data-testid="env">{currentPass()}</p>;
}

describe("renderRoute: hydrate", () => {
  it("server-renders the tree, then hydrates that HTML into an interactive root", async () => {
    // A hydration render returns the server snapshot; a fresh mount never does.
    const snapshots: string[] = [];
    function Counter() {
      const { id } = useParams<{ id: string }>();
      const snapshot = useSyncExternalStore(
        subscribeNever,
        () => "client",
        () => "server",
      );
      snapshots.push(snapshot);
      const [count, setCount] = useState(0);
      return (
        <button
          data-testid="counter"
          data-snapshot={snapshot}
          onClick={() => setCount((n) => n + 1)}
        >
          {`${id}:${count}`}
        </button>
      );
    }

    const { serverHtml, recoverableErrors, getByTestId, router } =
      await renderRoute([{ path: "/items/:id", Component: Counter }], {
        request: "/items/7",
        hydrate: true,
      });

    expect(serverHtml).toBe(
      '<button data-testid="counter" data-snapshot="server">7:0</button>',
    );
    expect(snapshots).toEqual(["server", "server", "client"]);
    expect(recoverableErrors).toEqual([]);

    const button = getByTestId("counter");
    expect(button.getAttribute("data-snapshot")).toBe("client");
    fireEvent.click(button);
    expect(button.textContent).toBe("7:1");

    await router.navigate("/items/8");
    expect(router.params()).toEqual({ id: "8" });
    expect(getByTestId("counter").textContent).toMatch(/^8:/);
  });

  it("without hydrate it mounts fresh and the result has no hydration fields", async () => {
    const passes: Pass[] = [];
    function Probe() {
      passes.push(currentPass());
      return <p data-testid="probe">probe</p>;
    }

    const result = await renderRoute([{ path: "/", Component: Probe }]);

    expect(passes).toEqual(["client"]);
    expect(result).not.toHaveProperty("serverHtml");
    expect(result).not.toHaveProperty("recoverableErrors");
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
    "#992: a reader hydrating after data-hydrated is set stays undefined, then shows the stored value ($label)",
    async ({ strict }) => {
      configure({ reactStrictMode: strict });
      const seen: Array<{ pass: Pass; count: number | undefined }> = [];
      function Count() {
        const state = useLocationState(GridState);
        seen.push({ pass: currentPass(), count: state?.count });
        return <p data-testid="count">{state?.count ?? 0}</p>;
      }

      // The root sets this attribute from its first effect, before a streamed
      // Suspense boundary hydrates. Present from the start, it makes this
      // hydration render the late one.
      document.documentElement.setAttribute("data-hydrated", "");
      const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
        [{ path: "/grid", Component: Count }],
        { hydrate: true, locationState: [[GridState, { count: 3 }]] },
      );

      // history.state is seeded before the server pass and must not reach it.
      expect(seen[0]).toEqual({ pass: "server", count: undefined });
      expect(serverHtml).toBe('<p data-testid="count">0</p>');
      expect(recoverableErrors).toEqual([]);
      const client = seen.filter((sample) => sample.pass === "client");
      expect(client[0]?.count).toBeUndefined();
      expect(client.at(-1)?.count).toBe(3);
      expect(getByTestId("count").textContent).toBe("3");
    },
  );

  it("a Suspense boundary hydrates after the effects of the tree above it", async () => {
    const seen: Array<{
      pass: Pass;
      count: number | undefined;
      rootEffectRan: boolean;
    }> = [];
    function Reader() {
      const state = useLocationState(GridState);
      seen.push({
        pass: currentPass(),
        count: state?.count,
        rootEffectRan:
          currentPass() === "client" &&
          document.documentElement.hasAttribute("data-hydrated"),
      });
      return <p data-testid="count">{state?.count ?? 0}</p>;
    }
    // What production's root does (browser/rsc-router.tsx Rango).
    function Page() {
      useEffect(() => {
        document.documentElement.setAttribute("data-hydrated", "");
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

    expect(serverHtml).toContain('<p data-testid="count">0</p>');
    const client = seen.filter((sample) => sample.pass === "client");
    expect(client[0]).toEqual({
      pass: "client",
      count: undefined,
      rootEffectRan: true,
    });
    expect(recoverableErrors).toEqual([]);
    expect(getByTestId("count").textContent).toBe("3");
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
