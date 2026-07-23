// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent } from "@testing-library/react";
import { useRouter } from "../../browser/react/use-router.js";
import { useHref } from "../../browser/react/use-href.js";
import { renderRoute } from "../render-route.js";

afterEach(() => {
  cleanup();
});

// Referential stability of the no-subscription hooks, exercised through the
// public renderRoute primitive. This is the unit-level guard for a regression
// that e2e CANNOT see: a memoized probe never re-renders, so an unstable closure
// (e.g. useHref returning a fresh function every render) stays invisible to a
// render-count assertion. Here we re-render the SAME component instance (via a
// local-state update, NOT a navigation, which would remount and reset the memo)
// and compare the returned references directly.
describe("useRouter / useHref referential stability (renderRoute)", () => {
  it("return the same reference across a re-render", async () => {
    const hrefRefs: Array<(p: `/${string}`) => string> = [];
    const routerRefs: unknown[] = [];

    function Probe() {
      const router = useRouter();
      const href = useHref();
      const [, setN] = useState(0);
      routerRefs.push(router);
      hrefRefs.push(href);
      return (
        <button data-testid="rerender" onClick={() => setN((n) => n + 1)}>
          {href("/")}
        </button>
      );
    }

    const { getByTestId } = await renderRoute(
      [{ path: "/p/:id", Component: Probe }],
      { request: "/p/1" },
    );

    expect(hrefRefs.length).toBeGreaterThanOrEqual(1);
    const firstHref = hrefRefs.at(-1);
    const firstRouter = routerRefs.at(-1);

    // Force a re-render of the SAME fiber via local state (no remount), so
    // stable hooks must return the identical reference. useHref returning a
    // fresh closure each render (the pre-fix bug) fails here.
    fireEvent.click(getByTestId("rerender"));

    expect(hrefRefs.length, "probe actually re-rendered").toBeGreaterThan(1);
    expect(hrefRefs.at(-1), "useHref reference stable").toBe(firstHref);
    expect(routerRefs.at(-1), "useRouter reference stable").toBe(firstRouter);
  });

  it("useHref resolves root-relative paths", async () => {
    let resolved = "";
    function Probe() {
      const href = useHref();
      resolved = href("/widgets");
      return <span>{resolved}</span>;
    }
    await renderRoute([{ path: "/", Component: Probe }], { request: "/" });
    expect(resolved).toBe("/widgets");
  });
});
