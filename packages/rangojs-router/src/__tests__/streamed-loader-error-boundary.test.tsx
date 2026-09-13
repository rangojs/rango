// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StreamedLoaderErrorBoundary } from "../route-content-wrapper.js";
import { LOADER_ERROR_FALLBACK } from "../decode-loader-results.js";

afterEach(cleanup);

function Throwing(): null {
  const error = new Error("loader failed") as Error & Record<symbol, unknown>;
  error[LOADER_ERROR_FALLBACK] = <p>fallback for route one</p>;
  throw error;
}

describe("StreamedLoaderErrorBoundary", () => {
  it("clears a caught marker when resetKey changes, without remounting", () => {
    // Group-keyed segments keep this boundary instance across in-group
    // navigations; a marker caught for one route + params must not leak into
    // the next.
    const result = render(
      <StreamedLoaderErrorBoundary resetKey="R0">
        <Throwing />
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("fallback for route one")).toBeDefined();

    result.rerender(
      <StreamedLoaderErrorBoundary resetKey="R1">
        <p>route two</p>
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("route two")).toBeDefined();
    expect(result.queryByText("fallback for route one")).toBeNull();
  });

  it("keeps a caught marker while resetKey is unchanged", () => {
    const result = render(
      <StreamedLoaderErrorBoundary resetKey="R0">
        <Throwing />
      </StreamedLoaderErrorBoundary>,
    );
    result.rerender(
      <StreamedLoaderErrorBoundary resetKey="R0">
        <p>same route</p>
      </StreamedLoaderErrorBoundary>,
    );
    expect(result.getByText("fallback for route one")).toBeDefined();
  });
});
