/**
 * What a nested cache() scope takes from the scopes enclosing it.
 *
 * #975: a `key()` result is namespaced (`key:` + its URI encoding), so a
 * request-derived result can never name a default key or a composed key.
 * #974: an enclosing `condition()` gates every nested scope (AND), enclosing
 * `tags` tag every nested record (union), and an enclosing scope on another
 * store partitions the nested records by that store's keyGenerator result.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../segment-codec.js", () => ({
  deserializeSegments: vi.fn(async () => []),
}));

import {
  createCacheScope,
  resolveShellPartition,
  type CacheScope,
} from "../cache-scope.js";
import {
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import type { SegmentCacheStore } from "../types.js";
import type { PartialCacheOptions } from "../../types.js";
import { RecordingShellStore } from "../shell-snapshot.js";

type KeyFn = NonNullable<PartialCacheOptions["key"]>;

function recordingStore(
  extra: Partial<SegmentCacheStore> = {},
): SegmentCacheStore & { gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    async get(key: string) {
      gets.push(key);
      return null;
    },
    async set() {},
    async delete() {
      return false;
    },
    ...extra,
  };
}

function requestFor(
  headers: Record<string, string>,
  store: SegmentCacheStore,
  path = "/pricing",
): RequestContext {
  const url = new URL(`http://localhost${path}`);
  return {
    _requestTags: new Set<string>(),
    request: new Request(url, { headers }),
    url,
    originalUrl: url,
    _cacheStore: store,
  } as unknown as RequestContext;
}

/** The scope of a route under these cache() options, outermost first. */
function chain(...configs: Array<PartialCacheOptions | false>): CacheScope {
  let scope: CacheScope | null = null;
  configs.forEach((options, depth) => {
    scope = createCacheScope({ options }, scope, `C${depth}`);
  });
  return scope!;
}

const tierKey: KeyFn = (ctx) => `tier:${ctx.request.headers.get("x-tier")}`;
/** A key() returning request input as is: the #975 hazard. */
const bareKey: KeyFn = (ctx) => ctx.request.headers.get("x-tier") ?? "";
const constant =
  (value: string): KeyFn =>
  () =>
    value;

/** The key the route's record lookup reads under, for one request. */
async function recordKey(
  scope: CacheScope,
  headers: Record<string, string>,
  path = "/pricing",
  store: SegmentCacheStore & { gets: string[] } = recordingStore(),
): Promise<string | undefined> {
  const before = store.gets.length;
  await runWithRequestContext(requestFor(headers, store, path), () =>
    scope.lookupRoute(path, {}),
  );
  return store.gets[before];
}

function resolveIn(scope: CacheScope, defaultKey: string): Promise<string> {
  return runWithRequestContext(requestFor({}, recordingStore()), () =>
    scope.resolveKeyFrom(defaultKey),
  );
}

describe("cache() key() results are namespaced (#975)", () => {
  it("a single key() result is stored as `key:` plus its URI encoding", async () => {
    expect(await recordKey(chain({ key: tierKey }), { "x-tier": "gold" })).toBe(
      "key:tier%3Agold",
    );
    // Composed parts are namespaced the same way; a default key part is
    // encoded without the prefix.
    expect(
      await recordKey(chain({ key: tierKey }, { ttl: 30 }), {
        "x-tier": "gold",
      }),
    ).toBe("key:tier%3Agold|doc%3Alocalhost%2Fpricing");
    expect(
      await recordKey(chain({ key: tierKey }, { key: constant("v:a") }), {
        "x-tier": "gold",
      }),
    ).toBe("key:tier%3Agold|key:v%3Aa");
  });

  it("a raw key() result cannot name a default key: request input never lands in another route's record", async () => {
    const pricing = await recordKey(chain({ ttl: 60 }), {}, "/pricing");
    expect(pricing).toBe("doc:localhost/pricing");

    const crafted = await recordKey(
      chain({ key: bareKey }),
      { "x-tier": "doc:localhost/pricing" },
      "/other",
    );
    expect(crafted).not.toBe(pricing);
  });

  it("a raw key() result cannot name a composed key", async () => {
    const goldPricing = await recordKey(chain({ key: bareKey }, { ttl: 30 }), {
      "x-tier": "gold",
    });

    for (const value of [
      // The #970 probe: gold's inner /pricing key before #975.
      "gold|doc%3Alocalhost%2Fpricing",
      // The same key under the #975 scheme, and its raw parts.
      goldPricing!,
      "key:gold|doc%3Alocalhost%2Fpricing",
      "gold",
    ]) {
      const crafted = await recordKey(
        chain({ key: bareKey }),
        { "x-tier": value },
        "/other",
      );
      expect(crafted).not.toBe(goldPricing);
    }
  });

  it("collision probe: raw, composed and default keys never collide", async () => {
    const values = [
      "",
      "a",
      "a|b",
      "a%7Cb",
      "|",
      ":",
      "key:",
      "key:a",
      "key%3Aa",
      "doc:localhost/pricing",
      "doc%3Alocalhost%2Fpricing",
      "gold|doc%3Alocalhost%2Fpricing",
      "key:gold|doc%3Alocalhost%2Fpricing",
      "gold:navigation",
      "%",
      "%25",
      "a b",
    ];
    const defaults = [
      "doc:localhost/pricing",
      "partial:localhost/pricing",
      "intercept:localhost/pricing",
      "doc:localhost/a|b",
      "doc:localhost/key:a",
    ];
    const kinds = new Map<string, string>();
    const add = (kind: string, key: string) => {
      const seen = kinds.get(key);
      expect(seen, `${kind} ${JSON.stringify(key)} vs ${seen}`).toBeUndefined();
      kinds.set(key, kind);
    };

    for (const d of defaults) {
      add("default", await resolveIn(chain({ ttl: 60 }), d));
    }
    for (const v of values) {
      add("single", await resolveIn(chain({ key: constant(v) }), v));
    }
    for (const outer of values) {
      // Inner scope without key(): the outer result plus the default key.
      for (const d of defaults) {
        add(
          "outer+default",
          await resolveIn(chain({ key: constant(outer) }, { ttl: 30 }), d),
        );
      }
      // Inner scope with its own key(): both results.
      for (const inner of values) {
        add(
          "outer+inner",
          await resolveIn(
            chain({ key: constant(outer) }, { key: constant(inner) }),
            "doc:localhost/pricing",
          ),
        );
      }
    }
    const few = ["a", "|", "a|b", "key:a", ""];
    for (const a of few) {
      for (const b of few) {
        for (const c of few) {
          add(
            "triple",
            await resolveIn(
              chain(
                { key: constant(a) },
                { key: constant(b) },
                { key: constant(c) },
              ),
              "doc:localhost/pricing",
            ),
          );
        }
      }
    }
    expect(kinds.size).toBe(
      defaults.length +
        values.length +
        values.length * defaults.length +
        values.length ** 2 +
        few.length ** 3,
    );
  });

  it("a ppr route's shell partition namespaces the key() results the same way", async () => {
    const store = recordingStore();
    await runWithRequestContext(
      requestFor({ "x-tier": "gold" }, store),
      async () => {
        await expect(
          resolveShellPartition(chain({ key: tierKey }), store, "/pricing", {}),
        ).resolves.toBe("key:tier%3Agold");
        await expect(
          resolveShellPartition(
            chain({ key: tierKey }, { key: constant("v:a") }),
            store,
            "/pricing",
            {},
          ),
        ).resolves.toBe("key:tier%3Agold|key:v%3Aa");
      },
    );
  });

  it("no key() anywhere keeps the default key and the raw keyGenerator result, as before", async () => {
    const keyGenerator = (ctx: RequestContext, defaultKey: string) =>
      `${defaultKey}|${ctx.request.headers.get("x-locale")}`;
    const store = recordingStore({ keyGenerator });

    expect(await recordKey(chain({ ttl: 60 }, { ttl: 30 }), {})).toBe(
      "doc:localhost/pricing",
    );
    expect(
      await recordKey(
        chain({ ttl: 60 }),
        { "x-locale": "de" },
        "/pricing",
        store,
      ),
    ).toBe("doc:localhost/pricing|de");
    await runWithRequestContext(
      requestFor({ "x-locale": "de" }, store),
      async () => {
        await expect(
          resolveShellPartition(chain({ ttl: 60 }), store, "/pricing", {}),
        ).resolves.toBe("doc:localhost/pricing|de");
        await expect(
          resolveShellPartition(null, store, "/pricing", {}),
        ).resolves.toBe("doc:localhost/pricing|de");
      },
    );
  });
});

describe("a nested cache() inherits the enclosing condition() (#974)", () => {
  it("an enclosing condition() returning false bypasses a nested scope's read: no key, no store read", async () => {
    const keyFn = vi.fn(tierKey);
    const store = recordingStore();
    const scope = chain({ condition: () => false }, { ttl: 30, key: keyFn });

    const outcome = await runWithRequestContext(
      requestFor({ "x-tier": "gold" }, store),
      () => scope.lookupRouteDetailed("/pricing", {}),
    );

    expect(outcome).toEqual({ status: "bypass" });
    expect(store.gets).toEqual([]);
    expect(keyFn).not.toHaveBeenCalled();
  });

  it("an enclosing condition() returning false refuses the nested write and its tags", async () => {
    const store = recordingStore();
    const ctx = requestFor({}, store);
    const scope = chain(
      { condition: () => false },
      { ttl: 30, tags: ["inner"] },
    );

    runWithRequestContext(ctx, () => {
      expect(scope.allowsCache("read")).toBe(false);
      expect(scope.allowsCache("write")).toBe(false);
      scope.recordTags(ctx);
    });
    expect([...ctx._requestTags]).toEqual([]);
  });

  it("every enclosing condition() must allow it (AND), through a cache(false) re-enabled below", async () => {
    const allow = () => true;
    const refuse = () => false;
    const read = (scope: CacheScope) =>
      runWithRequestContext(requestFor({}, recordingStore()), () =>
        scope.allowsCache("read"),
      );

    expect(read(chain({ condition: allow }, { condition: allow }))).toBe(true);
    expect(read(chain({ condition: allow }, { condition: refuse }))).toBe(
      false,
    );
    expect(read(chain({ condition: refuse }, { condition: allow }))).toBe(
      false,
    );
    expect(read(chain({ condition: refuse }, false, { ttl: 30 }))).toBe(false);
    expect(read(chain({ ttl: 60 }, { ttl: 30 }))).toBe(true);
  });

  it("a single scope's condition() is unchanged: its own predicate alone decides", async () => {
    const store = recordingStore();
    const outcome = await runWithRequestContext(requestFor({}, store), () =>
      chain({ ttl: 60, condition: () => true }).lookupRouteDetailed(
        "/pricing",
        {},
      ),
    );
    expect(outcome).toEqual({ status: "miss" });
    expect(store.gets).toEqual(["doc:localhost/pricing"]);
  });
});

describe("a nested cache() inherits the enclosing tags (#974)", () => {
  it("recordTags records the enclosing static and function tags with its own", () => {
    const store = recordingStore();
    const ctx = requestFor({ "x-tier": "gold" }, store);
    const scope = chain(
      { tags: ["outer"] },
      { tags: (c) => [`tier:${c.request.headers.get("x-tier")}`] },
      false,
      { ttl: 30, tags: ["inner"] },
    );

    runWithRequestContext(ctx, () => scope.recordTags(ctx));

    expect([...ctx._requestTags].sort()).toEqual(
      ["inner", "outer", "tier:gold"].sort(),
    );
  });

  it("a single scope's tags are unchanged", () => {
    const store = recordingStore();
    const ctx = requestFor({}, store);
    runWithRequestContext(ctx, () =>
      chain({ ttl: 60, tags: ["only"] }).recordTags(ctx),
    );
    expect([...ctx._requestTags]).toEqual(["only"]);
  });
});

describe("an enclosing scope on another store partitions a nested scope by its keyGenerator (#974)", () => {
  const byLocale = (ctx: RequestContext, defaultKey: string) =>
    `${defaultKey}|${ctx.request.headers.get("x-locale")}`;

  it("B's records are partitioned by A's keyGenerator result", async () => {
    const storeA = recordingStore({ keyGenerator: byLocale });
    const storeB = recordingStore();
    const scope = chain({ store: storeA }, { store: storeB, ttl: 30 });

    const en = await recordKey(scope, { "x-locale": "en" }, "/pricing", storeB);
    const de = await recordKey(scope, { "x-locale": "de" }, "/pricing", storeB);

    expect(storeB.gets).toEqual([en, de]);
    expect(en).not.toBe(de);
    expect(en).toBe("doc%3Alocalhost%2Fpricing%7Cen|doc%3Alocalhost%2Fpricing");
  });

  it("with a key() of its own, B's record keeps A's partition too", async () => {
    const storeA = recordingStore({ keyGenerator: byLocale });
    const storeB = recordingStore();
    const scope = chain(
      { store: storeA },
      { store: storeB, key: constant("v:a") },
    );

    const en = await recordKey(scope, { "x-locale": "en" }, "/pricing", storeB);
    const de = await recordKey(scope, { "x-locale": "de" }, "/pricing", storeB);

    expect(en).toBe("key:v%3Aa|doc%3Alocalhost%2Fpricing%7Cen");
    expect(de).toBe("key:v%3Aa|doc%3Alocalhost%2Fpricing%7Cde");
  });

  it("the shell partition carries A's keyGenerator result", async () => {
    const storeA = recordingStore({ keyGenerator: byLocale });
    const storeB = recordingStore();
    const appStore = recordingStore();
    const scope = chain({ store: storeA }, { store: storeB, ttl: 30 });

    const partition = (locale: string) =>
      runWithRequestContext(requestFor({ "x-locale": locale }, appStore), () =>
        resolveShellPartition(scope, appStore, "/pricing", {}),
      );

    expect(await partition("en")).toBe("doc:localhost/pricing|en");
    expect(await partition("de")).toBe("doc:localhost/pricing|de");
  });

  it("a keyGenerator returning the default key partitions nothing", async () => {
    const storeA = recordingStore({
      keyGenerator: (_ctx: RequestContext, defaultKey: string) => defaultKey,
    });
    const storeB = recordingStore();
    const scope = chain({ store: storeA }, { store: storeB, ttl: 30 });

    expect(
      await recordKey(scope, { "x-locale": "en" }, "/pricing", storeB),
    ).toBe("doc:localhost/pricing");
  });

  it("on the same store the #970 rules are unchanged: the inner scope's own default key carries the keyGenerator result once", async () => {
    const store = recordingStore({ keyGenerator: byLocale });
    const scope = chain({ store }, { store, ttl: 30 });

    expect(
      await recordKey(scope, { "x-locale": "en" }, "/pricing", store),
    ).toBe("doc:localhost/pricing|en");
  });

  it("an outer cache() on the app store partitions a nested cache({ store })", async () => {
    const appStore = recordingStore({ keyGenerator: byLocale });
    const storeB = recordingStore();
    const scope = chain({ ttl: 60 }, { store: storeB, ttl: 30 });
    const key = async (locale: string) => {
      const before = storeB.gets.length;
      await runWithRequestContext(
        requestFor({ "x-locale": locale }, appStore),
        () => scope.lookupRoute("/pricing", {}),
      );
      return storeB.gets[before];
    };

    expect(await key("en")).toBe(
      "doc%3Alocalhost%2Fpricing%7Cen|doc%3Alocalhost%2Fpricing",
    );
    expect(await key("de")).not.toBe(await key("en"));
  });

  /**
   * A keyGenerator that returns the default key for its default value (a
   * locale `en`, a region `us`) partitions nothing for it. Dropping that part
   * lost its position: `{ en, de }` and `{ de, us }` kept the one surviving
   * part `…|de` and shared a record and a shell.
   */
  describe("keyGenerator parts keep their position when one returns the default key", () => {
    const partitionBy =
      (header: string, fallback: string) =>
      (ctx: RequestContext, defaultKey: string) => {
        const value = ctx.request.headers.get(header) ?? fallback;
        return value === fallback ? defaultKey : `${defaultKey}|${value}`;
      };
    const request = (locale: string, region: string) => ({
      "x-locale": locale,
      "x-region": region,
    });

    it("the record key: two enclosing stores over a plain inner store", async () => {
      const localeStore = recordingStore({
        keyGenerator: partitionBy("x-locale", "en"),
      });
      const regionStore = recordingStore({
        keyGenerator: partitionBy("x-region", "us"),
      });
      const inner = recordingStore();
      const scope = chain(
        { store: localeStore },
        { store: regionStore },
        { store: inner, ttl: 30 },
      );
      const key = (locale: string, region: string) =>
        recordKey(scope, request(locale, region), "/p", inner);

      const enDe = await key("en", "de");
      const deUs = await key("de", "us");
      expect(enDe).not.toBe(deUs);
      // A default result keeps its place as an empty part.
      expect(enDe).toBe("|doc%3Alocalhost%2Fp%7Cde|doc%3Alocalhost%2Fp");
      expect(deUs).toBe("doc%3Alocalhost%2Fp%7Cde||doc%3Alocalhost%2Fp");
      // Both default: the key is unchanged.
      expect(await key("en", "us")).toBe("doc:localhost/p");
    });

    it("the shell partition: an enclosing store and the route's own store", async () => {
      const localeStore = recordingStore({
        keyGenerator: partitionBy("x-locale", "en"),
      });
      const regionStore = recordingStore({
        keyGenerator: partitionBy("x-region", "us"),
      });
      const appStore = recordingStore();
      const scope = chain(
        { store: localeStore },
        { store: regionStore, ttl: 30 },
      );
      const partition = (locale: string, region: string) =>
        runWithRequestContext(
          requestFor(request(locale, region), appStore),
          () => resolveShellPartition(scope, appStore, "/p", {}),
        );

      const enDe = await partition("en", "de");
      const deUs = await partition("de", "us");
      expect(enDe).not.toBe(deUs);
      expect(enDe).toBe("|doc%3Alocalhost%2Fp%7Cde");
      expect(deUs).toBe("doc%3Alocalhost%2Fp%7Cde|");
      // Both default: no partition, as before.
      expect(await partition("en", "us")).toBeNull();
      // One enclosing store alone keeps its raw result, as before.
      const single = chain(
        { store: localeStore },
        { store: appStore, ttl: 30 },
      );
      await expect(
        runWithRequestContext(requestFor(request("de", "us"), appStore), () =>
          resolveShellPartition(single, appStore, "/p", {}),
        ),
      ).resolves.toBe("doc:localhost/p|de");
    });
  });
});

describe("keyGenerator parts across a capture and an empty result (#974)", () => {
  const byLocale = (ctx: RequestContext, defaultKey: string) =>
    `${defaultKey}|${ctx.request.headers.get("x-locale")}`;

  it("a chain naming the app store explicitly resolves the same record key in the capture as in the request", async () => {
    // shell-capture.ts wraps the app store for the capture
    // (RecordingShellStore); an explicit store stays unwrapped.
    const appStore = recordingStore({ keyGenerator: byLocale });
    const scope = chain({ store: appStore }, { ttl: 30 });
    const foreground = requestFor({ "x-locale": "de" }, appStore);

    const live = await runWithRequestContext(foreground, () =>
      scope.resolveKeyFrom("doc:localhost/p"),
    );
    const capture = Object.assign(Object.create(foreground), {
      _cacheStore: new RecordingShellStore(appStore),
    }) as RequestContext;
    const captured = await runWithRequestContext(capture, () =>
      scope.resolveKeyFrom("doc:localhost/p"),
    );

    expect(live).toBe("doc:localhost/p|de");
    expect(captured).toBe(live);
  });

  describe("a keyGenerator that returns an empty key", () => {
    // `empty` makes the locale store return "", which read like the empty
    // part of a store that returned the default key.
    const localeStore = () =>
      recordingStore({
        keyGenerator: (ctx: RequestContext, defaultKey: string) => {
          const locale = ctx.request.headers.get("x-locale");
          if (locale === "empty") return "";
          return locale === "en" ? defaultKey : `${defaultKey}|${locale}`;
        },
      });
    const regionStore = () =>
      recordingStore({
        keyGenerator: (ctx: RequestContext, defaultKey: string) => {
          const region = ctx.request.headers.get("x-region");
          return region === "us" ? defaultKey : `${defaultKey}|${region}`;
        },
      });
    const request = (locale: string, region: string) => ({
      "x-locale": locale,
      "x-region": region,
    });

    it("never shares a record: the request renders uncached, and the store is named once", async () => {
      const locale = localeStore();
      const region = regionStore();
      const inner = recordingStore();
      const scope = chain(
        { store: locale },
        { store: region },
        { store: inner, ttl: 30 },
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      const enDe = await recordKey(scope, request("en", "de"), "/p", inner);
      const outcome = await runWithRequestContext(
        requestFor(request("empty", "de"), inner, "/p"),
        () => scope.lookupRouteDetailed("/p", {}),
      );
      await runWithRequestContext(
        requestFor(request("empty", "fr"), inner, "/p"),
        () => scope.lookupRouteDetailed("/p", {}),
      );

      expect(enDe).toBe("|doc%3Alocalhost%2Fp%7Cde|doc%3Alocalhost%2Fp");
      expect(outcome).toEqual({ status: "error" });
      // Only the en request read the store.
      expect(inner.gets).toEqual([enDe]);
      const warnings = warn.mock.calls
        .map((args) => String(args[0]))
        .filter((message) => message.includes("empty key"));
      expect(warnings).toHaveLength(1);
      warn.mockRestore();
      error.mockRestore();
    });

    it("never shares a shell: the partition fails and no shell is served", async () => {
      const locale = localeStore();
      const region = regionStore();
      const appStore = recordingStore();
      const scope = chain({ store: locale }, { store: region, ttl: 30 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const partition = (localeName: string, regionName: string) =>
        runWithRequestContext(
          requestFor(request(localeName, regionName), appStore),
          () => resolveShellPartition(scope, appStore, "/p", {}),
        );

      await expect(partition("en", "de")).resolves.toBe(
        "|doc%3Alocalhost%2Fp%7Cde",
      );
      await expect(partition("empty", "de")).rejects.toThrow(/empty key/);
      warn.mockRestore();
    });
  });
});
