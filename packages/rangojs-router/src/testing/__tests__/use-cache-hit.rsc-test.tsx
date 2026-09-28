/**
 * A "use cache" hit through the public testing primitives (issue #939), in
 * the react-server Flight project. The functions are written with the
 * directive (fixtures/use-cache-data.tsx) and wrapped by
 * rangoUseCacheTransform() (vitest.rsc.config.ts); the codec is the
 * plugin-rsc stub rangoTestAliases ships (src/testing/vitest-stubs/plugin-rsc.ts).
 * With a seeded cacheStore the first call writes the entry and a later call
 * reads it: the body runs once, and the value comes back through a real
 * Flight round trip.
 *
 * The write is a background (waitUntil) task the primitives do not await; a
 * call made before it lands joins the in-flight execution
 * (cache-runtime.ts inFlightExecutions) instead of reading the store. Each
 * test waits for the write so the store lookups are what it asserts.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { runLoader } from "../run-loader.js";
import {
  findClientBoundaries,
  renderHandler,
  textContent,
} from "../flight.entry.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type { HandlerContext } from "../../types/handler-context.js";
import {
  getDay,
  getForm,
  getGreeting,
  getPanel,
  getProduct,
  getReport,
  runs,
} from "./fixtures/use-cache-data.js";

function spiedStore() {
  const cacheStore = new MemorySegmentCacheStore();
  const getItem = vi.spyOn(cacheStore, "getItem");
  const setItem = vi.spyOn(cacheStore, "setItem");
  return {
    options: { cacheStore, cacheProfiles: { default: { ttl: 60 } } },
    setItem,
    /** Settle the first `count` writes. */
    async written(count: number) {
      await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(count));
      await Promise.all(setItem.mock.results.map((result) => result.value));
    },
    /** Hit (true) or miss (false) for each lookup so far. */
    lookups() {
      return Promise.all(
        getItem.mock.results.map(
          async (result) => (await result.value) !== null,
        ),
      );
    },
  };
}

describe('"use cache" hit through the testing primitives', () => {
  it("runLoader: the second call reads the store and the value round-trips", async () => {
    const store = spiedStore();
    const load = () => runLoader(async () => getProduct("wine"), store.options);

    const first = await load();
    await store.written(1);
    const second = await load();

    expect(runs.getProduct).toBe(1);
    expect(await store.lookups()).toEqual([false, true]);
    // The dev id format: the path relative to the Vitest root, not a hash.
    expect(store.setItem.mock.calls[0]![0]).toMatch(
      /^use-cache:src\/testing\/__tests__\/fixtures\/use-cache-data\.tsx#\S*getProduct:/,
    );
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.tags).toBeInstanceOf(Set);
    expect(second.updatedAt).toBeInstanceOf(Date);
    expect(second.updatedAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("runLoader: an argument keyed by the reply encoder hits for an equal value only", async () => {
    const store = spiedStore();
    const load = (iso: string) =>
      runLoader(async () => getDay(new Date(iso)), store.options);

    expect(await load("2026-01-02T00:00:00.000Z")).toBe("2026-01-02");
    await store.written(1);
    expect(await load("2026-01-02T00:00:00.000Z")).toBe("2026-01-02");
    expect(await load("2026-01-03T00:00:00.000Z")).toBe("2026-01-03");

    expect(runs.getDay).toBe(2);
    expect(await store.lookups()).toEqual([false, true, false]);
  });

  it("renderHandler: the second render reads the handler's cached call from the store", async () => {
    async function GreetingPage(ctx: HandlerContext<{ name: string }>) {
      return <main>{await getGreeting(ctx.params.name)}</main>;
    }
    const store = spiedStore();
    const options = { params: { name: "Ada" }, ...store.options };

    const first = await renderHandler(GreetingPage, options);
    await store.written(1);
    const second = await renderHandler(GreetingPage, options);

    expect(runs.getGreeting).toBe(1);
    expect(await store.lookups()).toEqual([false, true]);
    expect(textContent(first.tree)).toBe("Hello Ada #1");
    expect(textContent(second.tree)).toBe("Hello Ada #1");
  });

  it("renderHandler: a cached client island keeps its boundary and props on a hit", async () => {
    async function PanelPage() {
      return <main>{await getPanel()}</main>;
    }
    const store = spiedStore();

    await renderHandler(PanelPage, store.options);
    await store.written(1);
    const { tree } = await renderHandler(PanelPage, store.options);

    expect(runs.getPanel).toBe(1);
    expect(await store.lookups()).toEqual([false, true]);
    const [counter] = findClientBoundaries(tree, "Counter");
    expect(counter.props.start).toBe(1);
    expect(counter.props.when).toBeInstanceOf(Date);
    expect(counter.props.tags).toEqual(new Map([["a", 1]]));
  });

  it("runLoader: a cached server reference comes back as the same reference", async () => {
    const store = spiedStore();
    const load = () => runLoader(async () => getForm(), store.options);

    await load();
    await store.written(1);
    const { action } = await load();

    expect(runs.getForm).toBe(1);
    expect(await store.lookups()).toEqual([false, true]);
    const reference = action as unknown as { $$typeof: symbol; $$id: string };
    expect(reference.$$typeof).toBe(Symbol.for("react.server.reference"));
    expect(reference.$$id).toBe("src/actions.ts#save");
  });

  it("runLoader: a value Flight encodes as an error row is not stored", async () => {
    const store = spiedStore();
    const load = (kind: "failed" | "ok") =>
      runLoader(async () => getReport(kind), store.options);

    await load("failed");
    await load("ok");
    await store.written(1);
    await load("failed");
    await load("ok");

    expect(runs["getReport:failed"]).toBe(2);
    expect(runs["getReport:ok"]).toBe(1);
    expect(store.setItem.mock.calls.map(([key]) => key)).toEqual([
      expect.stringContaining('"ok"'),
    ]);
  });
});
