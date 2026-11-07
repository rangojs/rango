// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { StreamedLoaderErrorBoundary } from "../route-content-wrapper.js";
import { LOADER_ERROR_FALLBACK } from "../decode-loader-results.js";
import { renderRedirectDigest } from "../errors.js";

// LoaderRedirect navigates through the router context; here it only names
// its target.
vi.mock("../loader-redirect.js", () => ({
  LoaderRedirect: ({ to }: { to: string }) => <p>redirecting to {to}</p>,
}));

afterEach(cleanup);

function Throwing(): null {
  const error = new Error("loader failed") as Error & Record<symbol, unknown>;
  error[LOADER_ERROR_FALLBACK] = <p>fallback for route one</p>;
  throw error;
}

/** A component's `throw redirect()`, as the Flight client decodes its row. */
function Redirecting(): null {
  throw Object.assign(new Error("decoded"), {
    digest: renderRedirectDigest({ to: "/target" }),
  });
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

  describe("a component's redirect", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("follows it in place of the segment's children", () => {
      const result = render(
        <StreamedLoaderErrorBoundary reset={["R0"]} owner={{}}>
          <Redirecting />
        </StreamedLoaderErrorBoundary>,
      );
      expect(result.getByText("redirecting to /target")).toBeDefined();
    });

    it("keeps following it while the segment delivery is the same", () => {
      const owner = {};
      const result = render(
        <StreamedLoaderErrorBoundary reset={["R0"]} owner={owner}>
          <Redirecting />
        </StreamedLoaderErrorBoundary>,
      );
      result.rerender(
        <StreamedLoaderErrorBoundary reset={["R0"]} owner={owner}>
          <p>unrelated re-render</p>
        </StreamedLoaderErrorBoundary>,
      );
      expect(result.getByText("redirecting to /target")).toBeDefined();
    });

    // The same route and params, rendered again (a redirect to the same
    // page with another search): the spent redirect must not stay on screen.
    it("clears it when a new delivery of the segment arrives under the same reset", () => {
      const result = render(
        <StreamedLoaderErrorBoundary reset={["R0"]} owner={{}}>
          <Redirecting />
        </StreamedLoaderErrorBoundary>,
      );
      result.rerender(
        <StreamedLoaderErrorBoundary reset={["R0"]} owner={{}}>
          <p>target</p>
        </StreamedLoaderErrorBoundary>,
      );
      expect(result.getByText("target")).toBeDefined();
    });

    it("leaves a loader's caught marker to the reset alone", () => {
      const result = render(
        <StreamedLoaderErrorBoundary reset={["R0"]} owner={{}}>
          <Throwing />
        </StreamedLoaderErrorBoundary>,
      );
      result.rerender(
        <StreamedLoaderErrorBoundary reset={["R0"]} owner={{}}>
          <p>new delivery, same loader data</p>
        </StreamedLoaderErrorBoundary>,
      );
      expect(result.getByText("fallback for route one")).toBeDefined();
    });
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
});
