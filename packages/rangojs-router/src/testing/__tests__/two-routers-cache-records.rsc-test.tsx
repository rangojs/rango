/**
 * Every cache family that holds one router's output, with two routers on one
 * host and path and one cache store (issue #1065), on each built-in store.
 * Both routers run the same version, so a store's version prefix is equal
 * for the two and only the key's router part keeps them apart.
 *
 * `MemorySegmentCacheStore` uses the key as it is. `CFCacheStore` and
 * `VercelCacheStore` map it to their own storage keys (URI-encoded into a
 * Cache API URL, a KV key digested past 512 bytes, a family prefix), which
 * these cases run instead of reading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { dispatch } from "../index.js";
import {
  cfStore,
  makeRouters,
  memoryStore,
  ownHit,
  ownMiss,
  resetRuns,
  runs,
  sharedRuns,
  shellServed,
  vercelStore,
  type App,
  type StoreUnderTest,
  type TestRouter,
} from "./helpers/two-router-fixture.js";

const SHARED_ORIGIN = "http://shared.example";

/** What a response text says rendered it: an app, and what the app read. */
function contentIn(text: string): string[] {
  return [
    ...new Set(
      text.match(
        /app-[ab]-(?:cached|stored|loader:brand-[ab]|fn:\/[ab]-other)/g,
      ) ?? [],
    ),
  ];
}

const document = async (
  router: TestRouter,
  path: string,
  partial = false,
): Promise<string[]> =>
  contentIn(
    (
      await serveShellRequest(router, `${SHARED_ORIGIN}${path}`, {
        ...(partial && { partial: true }),
      })
    ).body,
  );

interface Family {
  family: string;
  /** What the router's response says rendered it. */
  get(router: TestRouter): Promise<unknown>;
  /** The router's own output. */
  own(app: App): unknown;
  /** Body runs after each router's two requests: the second ran none. */
  bodyRuns(): unknown;
}

const oncePerRouter = { a: 1, b: 1 };

const FAMILIES: Family[] = [
  {
    family: "a route cache() record",
    get: (router) => document(router, "/cached"),
    own: (app) => [`app-${app}-cached`],
    bodyRuns: () => ({ ...runs }),
  },
  {
    family: "a navigation's cache() record",
    get: (router) => document(router, "/cached", true),
    own: (app) => [`app-${app}-cached`],
    bodyRuns: () => ({ ...runs }),
  },
  {
    family: "a document-cache response",
    get: (router) => document(router, "/stored"),
    own: (app) => [`app-${app}-stored`],
    bodyRuns: () => ({ ...runs }),
  },
  {
    family: "a response route's entry",
    get: async (router) =>
      (
        await dispatch(router, {
          request: new Request(`${SHARED_ORIGIN}/api/data`),
        })
      ).json(),
    own: (app) => ({ from: `app-${app}` }),
    bodyRuns: () => ({ ...runs }),
  },
  // The loader's ctx is the router's: its variables, env and reverse() map.
  {
    family: "a loader's own cache() entry",
    get: (router) => document(router, "/loader"),
    own: (app) => [`app-${app}-loader:brand-${app}`],
    bodyRuns: () => ({ a: sharedRuns.loader / 2, b: sharedRuns.loader / 2 }),
  },
  {
    family: 'a "use cache" entry of a function that takes ctx',
    get: (router) => document(router, "/fn"),
    own: (app) => [`app-${app}-fn:/${app}-other`],
    bodyRuns: () => ({ a: sharedRuns.navFor / 2, b: sharedRuns.navFor / 2 }),
  },
];

const STORES: Array<[string, () => StoreUnderTest]> = [
  ["MemorySegmentCacheStore", memoryStore],
  ["CFCacheStore with KV", cfStore],
  ["VercelCacheStore", vercelStore],
];

beforeEach(async () => {
  await resetShellTestState();
  resetRuns();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(STORES)(
  "two routers on one host and path over one %s",
  (_name, makeStore) => {
    it.each(FAMILIES)(
      "$family is read only by the router that wrote it",
      async ({ get, own, bodyRuns }) => {
        const store = makeStore();
        const routers = makeRouters(store.cacheStore);
        const served = async (app: App): Promise<unknown> => {
          const result = await get(routers[app]);
          await store.settle();
          return result;
        };

        expect(await served("a")).toEqual(own("a"));
        expect(await served("b")).toEqual(own("b"));

        // Each router's own entry serves its next request.
        expect(await served("a")).toEqual(own("a"));
        expect(await served("b")).toEqual(own("b"));
        expect(bodyRuns()).toEqual(oncePerRouter);
      },
    );

    it("a ppr shell is captured and served per router", async () => {
      const store = makeStore();
      const routers = makeRouters(store.cacheStore);
      const served = async (app: App) => {
        const result = await serveShellRequest(
          routers[app],
          `${SHARED_ORIGIN}/shelled`,
        );
        await store.settle();
        return shellServed(result);
      };

      expect(await served("a")).toEqual(ownMiss("a"));
      expect(await served("b")).toEqual(ownMiss("b"));
      expect(await served("a")).toEqual(ownHit("a"));
      expect(await served("b")).toEqual(ownHit("b"));
    });

    // Not one router's output: the entry is the function's value for its
    // arguments, and a bare Request names no router.
    it('a "use cache" function that takes the bare Request keeps one entry for both routers', async () => {
      const store = makeStore();
      const setItem = vi.spyOn(store.cacheStore, "setItem");
      const { a, b } = makeRouters(store.cacheStore);
      const text = async (router: TestRouter): Promise<string | undefined> => {
        const { body } = await serveShellRequest(
          router,
          `${SHARED_ORIGIN}/fn-request`,
        );
        await store.settle();
        return body.match(/app-[ab]-request:\/fn-request#\d+/)?.[0];
      };

      expect(await text(a)).toBe("app-a-request:/fn-request#1");
      // Router B's handler ran; the function's body did not.
      expect(await text(b)).toBe("app-b-request:/fn-request#1");
      expect(sharedRuns.pathOf).toBe(1);

      const keys = setItem.mock.calls.map(([key]) => String(key));
      expect(keys).toHaveLength(1);
      expect(keys[0]).toContain("shared.example/fn-request");
      expect(keys[0]).not.toContain("@");
    });
  },
);

// A KV key over 512 bytes is stored under a readable prefix and a digest of
// the whole key (CFCacheStore toKVKey). Two ids that differ only past that
// prefix still name two entries.
describe("CFCacheStore with KV: router ids longer than a KV key", () => {
  const LONG = "r".repeat(600);

  it("each router is served its own shell and record", async () => {
    const store = cfStore();
    const routers = makeRouters(store.cacheStore, {
      ids: { a: `${LONG}-a`, b: `${LONG}-b` },
    });
    const shell = async (app: App) => {
      const result = await serveShellRequest(
        routers[app],
        `${SHARED_ORIGIN}/shelled`,
      );
      await store.settle();
      return shellServed(result);
    };
    const record = async (app: App): Promise<string[]> => {
      const content = await document(routers[app], "/cached");
      await store.settle();
      return content;
    };

    expect(await shell("a")).toEqual(ownMiss("a"));
    expect(await shell("b")).toEqual(ownMiss("b"));
    expect(await shell("a")).toEqual(ownHit("a"));
    expect(await shell("b")).toEqual(ownHit("b"));

    expect(await record("a")).toEqual(["app-a-cached"]);
    expect(await record("b")).toEqual(["app-b-cached"]);
    const runsBefore = { ...runs };
    expect(await record("a")).toEqual(["app-a-cached"]);
    expect(await record("b")).toEqual(["app-b-cached"]);
    expect(runs).toEqual(runsBefore);

    // Both routers' keys were digested: one readable prefix, two digests.
    const digests = (family: string): string[] =>
      store
        .kvKeys()
        .filter((key) => key.startsWith(family) && key.length <= 512)
        .map((key) => key.split("~")[1]!);
    expect(new Set(digests("shell")).size).toBe(2);
    expect(new Set(digests("doc:")).size).toBe(2);
    expect(store.kvKeys().filter((key) => key.length > 512)).toEqual([]);
  });
});
