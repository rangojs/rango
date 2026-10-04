// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { startTransition, Suspense, useState, type ReactNode } from "react";
import { OutletProvider } from "../outlet-provider.js";
import { useFetchLoader, useLoader } from "../use-loader.js";
import { loaderStore } from "../loader-store.js";
import type { LoaderDefinition } from "../types.js";

/**
 * useLoader().isLoading on a HELD navigation. Mirrors what
 * browser/partial-update.ts commitInTransition does: the new tree carries a
 * still-pending per-loader stream, and announcePendingStreams(segments) runs
 * INSIDE the startTransition that commits it. The reader whose content React
 * keeps on screen must report isLoading:true from the urgent optimistic render
 * until the commit that brings the new data — never "fresh" on the old data in
 * between.
 */
const ProductLoader = { $$id: "product" } as unknown as LoaderDefinition<{
  name: string;
}>;
const OrphanLoader = { $$id: "orphan" } as unknown as LoaderDefinition<{
  name: string;
}>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let renders: string[] = [];
function Reader() {
  const { data, isLoading } = useLoader(ProductLoader);
  const status = `${isLoading ? "stale" : "fresh"}:${data.name}`;
  renders.push(status);
  return <p data-testid="status">{status}</p>;
}

function Orphan() {
  const { data, isLoading } = useFetchLoader(OrphanLoader);
  return <p data-testid="orphan">{`${isLoading}:${data?.name ?? "none"}`}</p>;
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

function seeded(name: string) {
  return (
    <OutletProvider content={null} loaderData={{ product: { name } }}>
      <Reader />
    </OutletProvider>
  );
}
function streaming(stream: Promise<unknown>) {
  return (
    <OutletProvider content={null} loaderStreams={{ product: stream }}>
      <Reader />
    </OutletProvider>
  );
}

function loaderSeg(loaderId: string, loaderData: unknown) {
  return { type: "loader", loaderId, loaderData };
}

function dedupe(list: string[]): string[] {
  return list.filter((v, i) => i === 0 || list[i - 1] !== v);
}

beforeEach(() => {
  renders = [];
});
afterEach(() => {
  cleanup();
  loaderStore.reset();
});

describe("useLoader isLoading on a held navigation", () => {
  it("pins isLoading:true on the held data until the transition commits the new data", async () => {
    const result = render(<Harness initial={seeded("P1")} />);
    expect(result.getByTestId("status").textContent).toBe("fresh:P1");

    const next = deferred<{ name: string }>();

    await act(async () => {
      startTransition(() => {
        loaderStore.announcePendingStreams([
          loaderSeg("product", next.promise),
        ]);
        setTree(streaming(next.promise));
      });
    });
    // Urgent optimistic render on the OLD tree; the new tree suspends at the
    // read site and is held (no skeleton).
    expect(result.getByTestId("status").textContent).toBe("stale:P1");
    expect(result.queryByTestId("skeleton")).toBeNull();

    await act(async () => {
      next.resolve({ name: "P2" });
      await next.promise;
    });
    expect(result.getByTestId("status").textContent).toBe("fresh:P2");
    expect(dedupe(renders)).toEqual(["fresh:P1", "stale:P1", "fresh:P2"]);
  });

  it("does not pin for a stream that settled before the commit (a fulfilled Flight chunk)", async () => {
    const result = render(<Harness initial={seeded("P1")} />);
    // A settled Flight chunk carries status/value, which use() unwraps
    // synchronously and trackPendingStream skips.
    const settled = Object.assign(Promise.resolve({ name: "P2" }), {
      status: "fulfilled",
      value: { name: "P2" },
    });
    await act(async () => {
      startTransition(() => {
        loaderStore.announcePendingStreams([loaderSeg("product", settled)]);
        setTree(streaming(settled));
      });
    });
    expect(result.getByTestId("status").textContent).toBe("fresh:P2");
    expect(renders).not.toContain("stale:P1");
  });

  it("leaves an ephemeral reader outside route context alone", async () => {
    const result = render(<Orphan />);
    expect(result.getByTestId("orphan").textContent).toBe("false:none");
    await act(async () => {
      startTransition(() =>
        loaderStore.announcePendingStreams([
          loaderSeg("orphan", new Promise(() => {})),
        ]),
      );
    });
    expect(result.getByTestId("orphan").textContent).toBe("false:none");
  });
});
