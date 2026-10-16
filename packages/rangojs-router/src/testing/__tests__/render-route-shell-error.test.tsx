// @vitest-environment happy-dom
import { Component, Suspense, use, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { usePathname } from "../../client.js";
import { renderRoute } from "../dom.entry.js";

// Userland contract for a document whose server render fails its shell
// (dc-t93): an error thrown with no <Suspense> above it. Production answers a
// recovery document and the browser renders the tree with createRoot, so the
// router's client error boundaries run, as on a client navigation to the URL.
// renderRoute's hydrate mode mirrors that and hands back the error.

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-hydrated");
});

const isServerPass = (): boolean => typeof window === "undefined";

describe("renderRoute hydrate: a server-pass shell error", () => {
  it("a component that throws only on the server renders on the client, and the error is handed back", async () => {
    const serverOnly = new Error("reads a server-only global");
    function Widget() {
      if (isServerPass()) throw serverOnly;
      return <p data-testid="widget">{usePathname()}</p>;
    }

    const { shellError, serverHtml, recoverableErrors, getByTestId } =
      await renderRoute([{ path: "/products", Component: Widget }], {
        hydrate: true,
      });

    expect(shellError).toBe(serverOnly);
    expect(serverHtml).toBe("");
    expect(recoverableErrors).toEqual([]);
    expect(getByTestId("widget").textContent).toBe("/products");
    expect(document.documentElement.hasAttribute("data-hydrated")).toBe(true);
  });

  it("a route that throws everywhere ends on the error boundary above it, as a client navigation does", async () => {
    const broken = new Error("broken route");
    class Boundary extends Component<
      { children: ReactNode },
      { error: Error | null }
    > {
      state = { error: null as Error | null };
      static getDerivedStateFromError(error: Error) {
        return { error };
      }
      render() {
        return this.state.error ? (
          <p data-testid="boundary">{this.state.error.message}</p>
        ) : (
          this.props.children
        );
      }
    }
    function Broken(): never {
      throw broken;
    }
    function Layout() {
      return (
        <Boundary>
          <Broken />
        </Boundary>
      );
    }

    const { shellError, getByTestId } = await renderRoute(
      [{ path: "/broken", Component: Layout }],
      { hydrate: true },
    );

    // The server pass runs no error boundaries, as React's server renderer.
    expect(shellError).toBe(broken);
    expect(getByTestId("boundary").textContent).toBe("broken route");
  });

  it("a tree that renders on the server hydrates and reports no shell error", async () => {
    function Page() {
      return <p data-testid="page">{usePathname()}</p>;
    }

    const { shellError, serverHtml } = await renderRoute(
      [{ path: "/ok", Component: Page }],
      { hydrate: true },
    );

    expect(shellError).toBeUndefined();
    expect(serverHtml).toBe('<p data-testid="page">/ok</p>');
  });

  it("a read that suspends outside Suspense still rejects: production's server waits for it", async () => {
    const never = new Promise<string>(() => {});
    function Pending() {
      return <p>{use(never)}</p>;
    }

    await expect(
      renderRoute([{ path: "/", Component: Pending }], { hydrate: true }),
    ).rejects.toThrow("suspended while responding to synchronous input");
  });

  it("a read that suspends inside Suspense keeps the fallback-then-client-render path", async () => {
    const never = new Promise<string>(() => {});
    function Pending() {
      return <p>{use(never)}</p>;
    }
    function Page() {
      return (
        <Suspense fallback={<i data-testid="fallback">loading</i>}>
          <Pending />
        </Suspense>
      );
    }

    const { shellError, serverHtml } = await renderRoute(
      [{ path: "/", Component: Page }],
      { hydrate: true },
    );

    expect(shellError).toBeUndefined();
    expect(serverHtml).toContain('<i data-testid="fallback">loading</i>');
  });
});
