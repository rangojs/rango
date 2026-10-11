// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Suspense, useDeferredValue, useState, type ReactNode } from "react";
import { OutletProvider } from "../outlet-provider.js";
import {
  LoaderBoundary,
  RouteContentWrapper,
} from "../route-content-wrapper.js";
import { useFetchLoader, useLoader } from "../use-loader.js";
import type { LoaderDefinition, ResolvedSegment } from "../types.js";

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

// The router's own boundaries read the same way: a place can be handed a
// pending promise in one tree and the arrived value in the next (a slot's
// aggregate whose streams have all arrived is the array,
// segment-loader-promise.ts; a route's content is its node once settled,
// segment-boundary-content.ts). React logs a component that suspended in
// use() on mount and then finished without it, so the value path calls use()
// too. React matches the two renders by fiber identity up the tree, so the
// log depends on how many commits came between them: one here (`bump`).
describe("router boundary read sites", () => {
  let setPage!: (tree: ReactNode) => void;
  let bump!: () => void;
  function Page() {
    const [tree, set] = useState<ReactNode>(null);
    const [commits, setCommits] = useState(0);
    setPage = set;
    bump = () => setCommits((n) => n + 1);
    return (
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        <i>{commits}</i>
        {tree}
      </Suspense>
    );
  }

  /** The tree mounts suspended on `pending`, one commit passes, then `arrived`. */
  async function handOver(pending: ReactNode, arrived: ReactNode) {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = render(<Page />);
    await act(async () => setPage(pending));
    expect(result.getByTestId("skeleton")).toBeTruthy();
    await act(async () => bump());
    await act(async () => setPage(arrived));
    expect(result.getByTestId("status")).toBeTruthy();
    return errors.mock.calls
      .map((args) => String(args[0]))
      .filter((text) => text.includes("conditional-use-of-use"));
  }

  it("LoaderResolver: a slot's aggregate handed as its array after its promise logs no conditional use()", async () => {
    const slot = { id: "L0.@badge", type: "parallel" } as ResolvedSegment;
    const badge = (data: Promise<unknown[]> | unknown[]) => (
      <LoaderBoundary
        loaderDataPromise={data}
        loaderIds={["badge"]}
        fallback={<p data-testid="skeleton">skeleton</p>}
        outletKey="L0.@badge"
        outletContent={null}
        segment={slot}
      >
        <p data-testid="status">badge</p>
      </LoaderBoundary>
    );
    expect(
      await handOver(
        badge(new Promise<unknown[]>(() => {})),
        badge([{ count: 3 }]),
      ),
    ).toEqual([]);
  });

  it("Suspender: a route's content handed as its node after its promise logs no conditional use()", async () => {
    const route = (content: unknown) => (
      <RouteContentWrapper
        content={content as ReactNode}
        fallback={<p data-testid="skeleton">skeleton</p>}
        segmentId="R0"
      />
    );
    expect(
      await handOver(
        route(new Promise<ReactNode>(() => {})),
        route(<p data-testid="status">content</p>),
      ),
    ).toEqual([]);
  });
});
