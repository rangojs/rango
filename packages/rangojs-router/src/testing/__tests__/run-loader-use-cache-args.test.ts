/**
 * "use cache" arguments through runLoader (issue #924), under the plugin-rsc
 * stubs that rangoTestAliases ships (src/testing/vitest-stubs/plugin-rsc.ts).
 * The stub encoder and serializer throw, so nothing is written and a hit is
 * not observable here; the store lookups are. A Request argument
 * (ctx.request) is looked up per URL; an argument that cannot be serialized
 * runs uncached and warns once in dev.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { runLoader } from "../run-loader.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { registerCachedFunction } from "../../cache/cache-runtime.js";

function spiedStore() {
  const store = new MemorySegmentCacheStore();
  const lookups: string[] = [];
  const getItem = store.getItem.bind(store);
  store.getItem = async (key: string) => {
    lookups.push(key);
    return getItem(key);
  };
  const options = {
    cacheStore: store,
    cacheProfiles: { default: { ttl: 60 } },
  };
  return { options, lookups };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runLoader: "use cache" arguments', () => {
  it("a Request argument is looked up per URL", async () => {
    const getPage = registerCachedFunction(
      async (request: Request, path: string) =>
        `${new URL(request.url).host}${path}`,
      "userland#getPage",
      "default",
    );
    const { options, lookups } = spiedStore();
    const load = (url: string) =>
      runLoader(async (ctx) => getPage(ctx.request, "/"), {
        request: url,
        ...options,
      });

    expect(await load("https://a.example/")).toBe("a.example/");
    expect(await load("https://a.example/")).toBe("a.example/");
    expect(await load("https://b.example/")).toBe("b.example/");
    expect(lookups).toHaveLength(3);
    expect(lookups[1]).toBe(lookups[0]);
    expect(lookups[2]).not.toBe(lookups[0]);
  });

  it("an argument that cannot be serialized runs uncached and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const withCallback = registerCachedFunction(
      async (_onDone: () => void) => ++calls,
      "userland#withCallback",
      "default",
    );
    const { options, lookups } = spiedStore();
    const load = () => runLoader(async () => withCallback(() => {}), options);

    expect(await load()).toBe(1);
    expect(await load()).toBe(2);
    expect(lookups).toEqual([]);
    const warnings = warn.mock.calls
      .map((args) => String(args[0]))
      .filter((message) => message.includes("userland#withCallback"));
    expect(warnings).toHaveLength(1);
  });
});
