// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import {
  startTransition,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Defer } from "../browser/defer.js";
import { OutletProvider } from "../outlet-provider.js";
import { RouteContentWrapper } from "../route-content-wrapper.js";
import { SETTLED_THENABLE } from "../thenable-status.js";
import { useLoader } from "../use-loader.js";
import type { LoaderDefinition } from "../types.js";

// A `prefetch: false` hole (browser/partial-update.ts armHoles) is one defer:
// every reader of it reads that one promise, and the read rule
// (browser/defer.ts readDefer) decides between the value and use().

/** Every value the router's read sites hand React's use(). */
const used = vi.hoisted(() => [] as unknown[]);
/** Runs at each use() call, before React reads the value. */
const onUse = vi.hoisted(() => ({
  current: undefined as ((usable: unknown) => void) | undefined,
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    use: <T,>(usable: Promise<T>): T => {
      used.push(usable);
      onUse.current?.(usable);
      return actual.use(usable);
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  used.length = 0;
  onUse.current = undefined;
});

const ReviewsLoader = { $$id: "reviews" } as unknown as LoaderDefinition<{
  count: number;
}>;

function Reader({ id }: { id: string }) {
  const { data } = useLoader(ReviewsLoader);
  return <p data-testid={id}>{data.count}</p>;
}

let fallbacks = 0;
function Fallback(): ReactNode {
  useEffect(() => {
    fallbacks++;
  }, []);
  return <p data-testid="skeleton">skeleton</p>;
}

let setTree!: (tree: ReactNode) => void;
function Harness({ initial }: { initial: ReactNode }) {
  const [tree, set] = useState(initial);
  setTree = set;
  return <Suspense fallback={<Fallback />}>{tree}</Suspense>;
}

function mount() {
  fallbacks = 0;
  return render(<Harness initial={null} />);
}

/** React's warnings about use(), captured: none may be logged. */
function captureWarnings() {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  return () =>
    errors.mock.calls
      .map((args) => String(args[0]))
      .filter(
        (text) =>
          text.includes("conditional-use-of-use") ||
          text.includes("suspended by an uncached promise"),
      );
}

const readers = (hole: Defer<unknown>, ...ids: string[]) => (
  <OutletProvider content={null} loaderStreams={{ reviews: hole }}>
    {ids.map((id) => (
      <Reader key={id} id={id} />
    ))}
  </OutletProvider>
);

describe("Defer", () => {
  it("sets status and value on the defer when it resolves, and writes nothing on its promise", async () => {
    const hole = new Defer<{ count: number }>();
    expect(hole).toBeInstanceOf(Defer);
    expect(hole.status).toBe("pending");
    expect(hole.read).toBeFalsy();
    const { promise } = hole;

    const value = { count: 3 };
    hole.resolve(value);
    expect(hole).toMatchObject({ status: "fulfilled", value });
    expect(hole.promise).toBe(promise);
    await expect(promise).resolves.toBe(value);
    expect(promise).not.toHaveProperty("status");
    expect(promise).not.toHaveProperty("value");
  });

  // Resolved with a stream, the router does not hold the value until the
  // stream arrives: the promise follows the stream, and so do status and
  // value, on the defer, never on its promise.
  it("resolved with a stream, status and value follow it", async () => {
    const hole = new Defer<unknown>();
    let arrive!: (value: unknown) => void;
    hole.resolve(new Promise((resolve) => (arrive = resolve)));
    expect(hole.status).toBe("pending");
    expect(hole.value).toBeUndefined();

    arrive({ count: 5 });
    await expect(hole.promise).resolves.toEqual({ count: 5 });
    expect(hole).toMatchObject({ status: "fulfilled", value: { count: 5 } });
    expect(hole.promise).not.toHaveProperty("status");
  });

  it("stays pending when its stream rejects, and its promise carries the rejection", async () => {
    const hole = new Defer<unknown>();
    const failure = new Error("stream failed");
    hole.resolve(Promise.reject(failure));
    await expect(hole.promise).rejects.toBe(failure);
    expect(hole.status).toBe("pending");
    expect(hole.value).toBeUndefined();
  });
});

describe("reading a hole", () => {
  it("hands every reader of a deferred loader the one promise of its defer", async () => {
    const warnings = captureWarnings();
    const hole = new Defer<unknown>();
    const result = mount();
    await act(async () => setTree(readers(hole, "a", "b")));
    expect(result.getByTestId("skeleton")).toBeTruthy();

    await act(async () => hole.resolve({ count: 2 }));
    expect((await result.findByTestId("a")).textContent).toBe("2");
    expect(result.getByTestId("b").textContent).toBe("2");

    const promises = used.filter((usable) => usable !== SETTLED_THENABLE);
    expect(promises.length).toBeGreaterThanOrEqual(2);
    expect(new Set(promises)).toEqual(new Set([hole.promise]));
    expect(hole.read).toBe(true);
    expect(warnings()).toEqual([]);
  });

  // Never read, a fulfilled hole is its value: use() of a promise React has
  // not seen suspends an urgent render once and shows the fallback. That is
  // the place below another hole on a failed fill (fillHoles).
  it.each([
    [
      "a route's content",
      (hole: Defer<unknown>) => (
        <RouteContentWrapper
          content={hole as unknown as ReactNode}
          fallback={<Fallback />}
          segmentId="R0"
        />
      ),
      "content",
    ],
    ["a useLoader() read", (hole: Defer<unknown>) => readers(hole, "a"), "a"],
  ])(
    "renders %s from a fulfilled hole never read with no suspension",
    (_label, tree, id) => {
      const hole = new Defer<unknown>();
      hole.resolve(
        id === "content" ? <p data-testid="content">content</p> : { count: 1 },
      );
      const result = mount();
      act(() => setTree(tree(hole)));

      expect(result.getByTestId(id).textContent).toBe(
        id === "content" ? "content" : "1",
      );
      expect(fallbacks, "no fallback committed").toBe(0);
      expect(used).not.toContain(hole.promise);
      expect(hole.promise, "React never read it").not.toHaveProperty("status");
      expect(hole.read).toBeFalsy();
    },
  );

  // Once a reader suspended on the hole, every read is use() of the same
  // promise: React marked it, so the read returns at once, and a component
  // that suspended in use() keeps calling it with the same thenable.
  it.each([
    [
      "a route's content",
      (hole: Defer<unknown>) => (
        <RouteContentWrapper
          content={hole as unknown as ReactNode}
          fallback={<Fallback />}
          segmentId="R0"
        />
      ),
      "content",
    ],
    ["a useLoader() read", (hole: Defer<unknown>) => readers(hole, "a"), "a"],
  ])(
    "reads %s from a hole it suspended on at once after it resolves, with no use() warning",
    async (_label, tree, id) => {
      const warnings = captureWarnings();
      const hole = new Defer<unknown>();
      const result = mount();
      await act(async () => setTree(tree(hole)));
      expect(result.getByTestId("skeleton")).toBeTruthy();
      expect(hole.read).toBe(true);

      await act(async () =>
        hole.resolve(
          id === "content" ? (
            <p data-testid="content">content</p>
          ) : (
            { count: 4 }
          ),
        ),
      );
      const text = id === "content" ? "content" : "4";
      expect((await result.findByTestId(id)).textContent).toBe(text);

      // A later render of the same tree, urgent: no fallback, no warning.
      const shown = fallbacks;
      act(() => setTree(tree(hole)));
      expect(result.getByTestId(id).textContent).toBe(text);
      expect(fallbacks).toBe(shown);
      expect(warnings()).toEqual([]);
    },
  );

  // A time-sliced render whose reader suspends on the hole, and the hole
  // resolves before React continues: React replays the reader with the
  // thenables it read the first time. The replay must hand use() the same
  // promise, not switch to the value (React logs "A component was suspended
  // by an uncached promise"). act() renders without time slicing and starts
  // over instead, so this runs on the real scheduler.
  it("replays a reader that suspended on a hole with the same promise, with no use() warning", async () => {
    const warnings = captureWarnings();
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement("div");
    const root = createRoot(container);
    const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
    try {
      const hole = new Defer<unknown>();
      // The hole resolves in the microtask after the reader suspended,
      // before React's next slice. Queued from the read itself: a sibling
      // rendered first can end React's slice before the reader renders.
      onUse.current = (usable) => {
        if (usable !== hole.promise) return;
        queueMicrotask(() => {
          if (hole.status === "pending") hole.resolve({ count: 6 });
        });
      };
      root.render(<Harness initial={null} />);
      await wait();
      startTransition(() => setTree(readers(hole, "a")));
      await wait();
      expect(container.textContent).toBe("6");
      expect(warnings()).toEqual([]);
      expect(
        used.filter((usable) => usable !== SETTLED_THENABLE),
        "the first read and its replay",
      ).toEqual([hole.promise, hole.promise]);
    } finally {
      root.unmount();
      env.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
  });
});
