// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { StreamedLoaderErrorBoundary } from "../route-content-wrapper.js";
import { LOADER_ERROR_FALLBACK } from "../decode-loader-results.js";

afterEach(cleanup);

function Throwing(): null {
  const error = new Error("loader failed") as Error & Record<symbol, unknown>;
  error[LOADER_ERROR_FALLBACK] = <p>fallback for route one</p>;
  throw error;
}

describe("StreamedLoaderErrorBoundary", () => {
  it("clears a caught marker when the route or params change, without remounting", () => {
    // Group-keyed segments keep this boundary instance across in-group
    // navigations; a marker caught for one route + params must not leak into
    // the next.
    const result = render(
      <StreamedLoaderErrorBoundary reset={["R0"]}>
        <Throwing />
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("fallback for route one")).toBeDefined();

    result.rerender(
      <StreamedLoaderErrorBoundary reset={["R1"]}>
        <p>route two</p>
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("route two")).toBeDefined();
    expect(result.queryByText("fallback for route one")).toBeNull();
  });

  it("keeps a caught marker while the route and params are unchanged", () => {
    const result = render(
      <StreamedLoaderErrorBoundary reset={["R0"]}>
        <Throwing />
      </StreamedLoaderErrorBoundary>,
    );
    result.rerender(
      <StreamedLoaderErrorBoundary reset={["R0"]}>
        <p>same route</p>
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("fallback for route one")).toBeDefined();
  });

  // A rerun hands the segment new loader data: an error fallback caught for
  // the earlier delivery clears, in the same instance.
  it("clears a caught marker when its loader data changes", () => {
    const first = Promise.resolve("failed");
    const result = render(
      <StreamedLoaderErrorBoundary reset={["R0", first]}>
        <Throwing />
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("fallback for route one")).toBeDefined();
    result.rerender(
      <StreamedLoaderErrorBoundary reset={["R0", Promise.resolve("ok")]}>
        <p>fresh data</p>
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("fresh data")).toBeDefined();
  });

  it("keeps a caught marker when its loader data is the same (held)", () => {
    const held = Promise.resolve("failed");
    const result = render(
      <StreamedLoaderErrorBoundary reset={["R0", held]}>
        <Throwing />
      </StreamedLoaderErrorBoundary>,
    );
    result.rerender(
      <StreamedLoaderErrorBoundary reset={["R0", held]}>
        <p>unrelated re-render</p>
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("fallback for route one")).toBeDefined();
  });

  it("does not remount healthy children when its loader data changes", () => {
    const mounted = vi.fn();
    function Child({ n }: { n: number }) {
      useEffect(() => mounted(), []);
      return <p data-testid="child">{n}</p>;
    }
    const result = render(
      <StreamedLoaderErrorBoundary reset={["R0", {}]}>
        <Child n={1} />
      </StreamedLoaderErrorBoundary>,
    );
    const child = result.getByTestId("child");
    result.rerender(
      <StreamedLoaderErrorBoundary reset={["R0", {}]}>
        <Child n={2} />
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByTestId("child")).toBe(child);
    expect(child.textContent).toBe("2");
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  // A fallback the tree build settled renders where a caught marker does,
  // in the same instance, so the content's wrappers stay in the element tree.
  it("renders a settled fallback in place of its children, and the children again once it is gone", () => {
    const result = render(
      <StreamedLoaderErrorBoundary reset={["R0", {}]}>
        <p>content</p>
      </StreamedLoaderErrorBoundary>,
    );
    result.rerender(
      <StreamedLoaderErrorBoundary
        reset={["R0", {}]}
        settledFallback={<p>settled fallback</p>}
      >
        <p>content</p>
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("settled fallback")).toBeDefined();
    expect(result.queryByText("content")).toBeNull();
    result.rerender(
      <StreamedLoaderErrorBoundary reset={["R0", {}]}>
        <p>content</p>
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("content")).toBeDefined();
  });

  it("renders a falsy settled fallback, not its children", () => {
    const result = render(
      <StreamedLoaderErrorBoundary reset={["R0"]} settledFallback={0}>
        <p>content</p>
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.container.textContent).toBe("0");
  });

  it("puts a settled fallback in the place of the marker it caught, after its loader data changed", () => {
    const result = render(
      <StreamedLoaderErrorBoundary reset={["R0", {}]}>
        <Throwing />
      </StreamedLoaderErrorBoundary>,
    );
    const caught = result.getByText("fallback for route one");
    result.rerender(
      <StreamedLoaderErrorBoundary
        reset={["R0", {}]}
        settledFallback={<p>settled fallback</p>}
      >
        <Throwing />
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("settled fallback")).toBe(caught);
  });

  // A marker thrown by the settled fallback itself is caught here, as one
  // thrown by a fallback this boundary rendered for a read. Rendering the
  // settled fallback again would throw again.
  it("keeps a marker the settled fallback threw over the settled fallback", () => {
    const result = render(
      <StreamedLoaderErrorBoundary
        reset={["R0"]}
        settledFallback={<Throwing />}
      >
        <p>content</p>
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("fallback for route one")).toBeDefined();
  });
});
