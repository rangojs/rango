// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Suspense, useDeferredValue, useState, type ReactNode } from "react";
import { OutletProvider } from "../outlet-provider.js";
import { useFetchLoader, useLoader } from "../use-loader.js";
import { loaderStore } from "../loader-store.js";
import type { LoaderDefinition } from "../types.js";

// Why every read with route context calls use(): see use-loader.tsx.
const ProductLoader = { $$id: "product" } as unknown as LoaderDefinition<{
  name: string;
}>;

function Reader() {
  const { data } = useLoader(ProductLoader);
  return <p data-testid="status">{data.name}</p>;
}

let setTree!: (tree: ReactNode) => void;
function Harness({ initial }: { initial: ReactNode }) {
  const [tree, set] = useState(initial);
  setTree = set;
  return (
    <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
      {tree}
    </Suspense>
  );
}

afterEach(() => {
  cleanup();
  loaderStore.reset();
  vi.restoreAllMocks();
});

describe("useLoader read sites", () => {
  it("call use() on a settled value too, so a reader that mounted suspended logs no conditional use()", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolve!: (value: unknown) => void;
    const stream = new Promise((r) => (resolve = r));
    const result = render(<Harness initial={null} />);
    await act(async () =>
      setTree(
        <OutletProvider content={null} loaderStreams={{ product: stream }}>
          <Reader />
        </OutletProvider>,
      ),
    );
    expect(result.getByTestId("skeleton")).toBeTruthy();
    await act(async () => resolve({ name: "streamed" }));
    // React reveals a boundary no sooner than 300 ms after its fallback.
    expect((await result.findByTestId("status")).textContent).toBe("streamed");

    act(() =>
      setTree(
        <OutletProvider
          content={null}
          loaderData={{ product: { name: "settled" } }}
        >
          <Reader />
        </OutletProvider>,
      ),
    );
    expect(result.getByTestId("status").textContent).toBe("settled");
    const logged = errors.mock.calls.map((args) => String(args[0]));
    expect(
      logged.filter((text) => text.includes("conditional-use-of-use")),
    ).toEqual([]);
  });

  it("a read with no route context does not call use(), so a synchronous act() still flushes", () => {
    // use() inside act() marks the render as having used a promise, and a
    // synchronous act() then stops flushing (react.development.js).
    function Outside() {
      useFetchLoader(ProductLoader);
      const value = useDeferredValue("final", "initial");
      return <p data-testid="deferred">{value}</p>;
    }
    const result = render(<Outside />);
    act(() => {});
    expect(result.getByTestId("deferred").textContent).toBe("final");
  });
});
