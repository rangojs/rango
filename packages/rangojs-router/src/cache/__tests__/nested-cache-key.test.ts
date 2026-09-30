/**
 * Record keys of nested cache() scopes (#970): a cache() inside a keyed
 * cache() keys its records within the enclosing key() partition. Without its
 * own key() it composes the partition with its own default key, so its routes
 * keep their own records; with one, the key() results compose. Each part is
 * URI-encoded, a key() result behind a `key:` prefix (#975), so no two
 * partitions ever share an inner record.
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

const header =
  (name: string, prefix: string): KeyFn =>
  (ctx) =>
    `${prefix}:${ctx.request.headers.get(name)}`;
const tierKey = header("x-tier", "tier");
const variantKey = header("x-variant", "v");

/** The key the route's record lookup reads under, for one request. */
async function recordKey(
  scope: CacheScope,
  headers: Record<string, string>,
  path = "/pricing",
): Promise<string | undefined> {
  const store = recordingStore();
  await runWithRequestContext(requestFor(headers, store, path), () =>
    scope.lookupRoute(path, {}),
  );
  return store.gets[0];
}

describe("nested cache() record keys (#970)", () => {
  it("an inner cache() without key() keys its records by the enclosing partition and its own default key", async () => {
    const scope = chain({ ttl: 60, key: tierKey }, { ttl: 30 });

    expect(await recordKey(scope, { "x-tier": "gold" })).toBe(
      "key:tier%3Agold|doc%3Alocalhost%2Fpricing",
    );
    expect(await recordKey(scope, { "x-tier": "silver" })).toBe(
      "key:tier%3Asilver|doc%3Alocalhost%2Fpricing",
    );
  });

  it("two routes under an inner cache() without key() keep their own records, though the outer key() names no route", async () => {
    const outer = createCacheScope({ options: { key: tierKey } }, null, "C0")!;
    const inner = createCacheScope({ options: { ttl: 30 } }, outer, "C0C1")!;
    const gold = { "x-tier": "gold" };

    const a = await recordKey(inner, gold, "/a");
    const b = await recordKey(inner, gold, "/b");
    expect(a).toBe("key:tier%3Agold|doc%3Alocalhost%2Fa");
    expect(b).toBe("key:tier%3Agold|doc%3Alocalhost%2Fb");
    // Nor do they share the record of a route directly under the outer
    // cache(), which is keyed by the key() result alone.
    expect(await recordKey(outer, gold, "/c")).toBe("key:tier%3Agold");
  });

  it("an inner `key: null` (a conditional key) counts as no key(): its routes keep their own records", async () => {
    // cache({ ttl, key: flag ? fn : null }), from untyped code.
    const noKey = { ttl: 30, key: null } as unknown as PartialCacheOptions;
    const outer = createCacheScope({ options: { key: tierKey } }, null, "C0")!;
    const inner = createCacheScope({ options: noKey }, outer, "C0C1")!;
    const gold = { "x-tier": "gold" };

    const keys = {
      a: await recordKey(inner, gold, "/a"),
      b: await recordKey(inner, gold, "/b"),
      c: await recordKey(outer, gold, "/c"),
    };
    expect(keys).toEqual({
      a: "key:tier%3Agold|doc%3Alocalhost%2Fa",
      b: "key:tier%3Agold|doc%3Alocalhost%2Fb",
      c: "key:tier%3Agold",
    });
  });

  it("an inner key() composes with the enclosing partition: tiers never share, the inner key still splits", async () => {
    const scope = chain({ key: tierKey }, { key: variantKey });
    const goldA = await recordKey(scope, {
      "x-tier": "gold",
      "x-variant": "a",
    });
    const silverA = await recordKey(scope, {
      "x-tier": "silver",
      "x-variant": "a",
    });
    const goldB = await recordKey(scope, {
      "x-tier": "gold",
      "x-variant": "b",
    });

    expect(goldA).toBe("key:tier%3Agold|key:v%3Aa");
    expect(silverA).toBe("key:tier%3Asilver|key:v%3Aa");
    expect(goldB).toBe("key:tier%3Agold|key:v%3Ab");
  });

  it("deeper nesting composes transitively; only the innermost scope's missing key() adds its default key", async () => {
    const headers = { "x-tier": "gold", "x-variant": "a", "x-locale": "de" };

    expect(
      await recordKey(
        chain({ key: tierKey }, { ttl: 30 }, { key: variantKey }),
        headers,
      ),
    ).toBe("key:tier%3Agold|key:v%3Aa");
    expect(
      await recordKey(
        chain({ key: tierKey }, { ttl: 30 }, { key: variantKey }, { ttl: 10 }),
        headers,
      ),
    ).toBe("key:tier%3Agold|key:v%3Aa|doc%3Alocalhost%2Fpricing");
    expect(
      await recordKey(
        chain(
          { key: tierKey },
          { key: variantKey },
          { key: header("x-locale", "l") },
        ),
        headers,
      ),
    ).toBe("key:tier%3Agold|key:v%3Aa|key:l%3Ade");
  });

  it("a single keyed scope is keyed by its namespaced key() result, at any depth; no key() keeps the default key", async () => {
    const headers = { "x-tier": "gold" };

    expect(await recordKey(chain({ key: tierKey }), headers)).toBe(
      "key:tier%3Agold",
    );
    expect(await recordKey(chain({ ttl: 60 }, { key: tierKey }), headers)).toBe(
      "key:tier%3Agold",
    );
    expect(await recordKey(chain({ ttl: 60 }, { ttl: 30 }), headers)).toBe(
      "doc:localhost/pricing",
    );
  });

  it("composed keys never collide, whatever the partition values", async () => {
    const values = [
      "",
      "a",
      "b",
      "a|b",
      "a%7Cb",
      "|",
      "%7C",
      ":",
      "gold:navigation",
      "%",
      "%25",
      "a b",
    ];
    const constant =
      (value: string): KeyFn =>
      () =>
        value;
    const resolve = (scope: CacheScope) =>
      runWithRequestContext(requestFor({}, recordingStore()), () =>
        scope.resolveKeyFrom("doc:localhost/pricing"),
      );

    const pairs = new Set<string>();
    for (const outer of values) {
      for (const inner of values) {
        pairs.add(
          await resolve(
            chain({ key: constant(outer) }, { key: constant(inner) }),
          ),
        );
      }
    }
    expect(pairs.size).toBe(values.length ** 2);

    const few = ["a", "|", "a|b", ""];
    const triples = new Set<string>();
    for (const a of few) {
      for (const b of few) {
        for (const c of few) {
          triples.add(
            await resolve(
              chain(
                { key: constant(a) },
                { key: constant(b) },
                { key: constant(c) },
              ),
            ),
          );
        }
      }
    }
    expect(triples.size).toBe(few.length ** 3);
    // A depth never names another depth's key, nor a single keyed scope's.
    for (const key of triples) expect(pairs.has(key)).toBe(false);
    for (const value of values) {
      const single = await resolve(chain({ key: constant(value) }));
      expect(pairs.has(single)).toBe(false);
      expect(triples.has(single)).toBe(false);
    }
  });

  it("a single key() result never names a composed key, prefixed or not (#975)", async () => {
    const gold = { "x-tier": "gold" };
    const crafted = { "x-tier": "gold|doc%3Alocalhost%2Fpricing" };
    const bare: KeyFn = (ctx) => ctx.request.headers.get("x-tier") ?? "";
    const inner = await recordKey(chain({ key: bare }, { ttl: 30 }), gold);

    // Before #975 the unprefixed crafted value was stored raw and named
    // gold's inner /pricing record.
    const single = await recordKey(chain({ key: bare }), crafted, "/other");
    expect(inner).toBe("key:gold|doc%3Alocalhost%2Fpricing");
    expect(single).toBe("key:gold%7Cdoc%253Alocalhost%252Fpricing");
    expect(single).not.toBe(inner);
    expect(
      await recordKey(chain({ key: tierKey }), crafted, "/other"),
    ).not.toBe(inner);
  });

  it("a key() on the chain with no request context rejects: never the broad default key", async () => {
    const keyFn = vi.fn(tierKey);

    await expect(
      chain({ key: keyFn }, { ttl: 30 }).resolveKeyFrom("doc:localhost/p"),
    ).rejects.toThrow(/request context/);
    expect(keyFn).not.toHaveBeenCalled();
    // Without a key() on the chain, the default key stays the answer.
    await expect(
      chain({ ttl: 60 }, { ttl: 30 }).resolveKeyFrom("doc:localhost/p"),
    ).resolves.toBe("doc:localhost/p");
  });

  it("cache(false) inside a keyed scope still caches nothing and runs no key()", async () => {
    const keyFn = vi.fn(tierKey);
    const store = recordingStore();
    const outcome = await runWithRequestContext(
      requestFor({ "x-tier": "gold" }, store),
      () => chain({ key: keyFn }, false).lookupRouteDetailed("/pricing", {}),
    );

    expect(outcome).toEqual({ status: "bypass" });
    expect(store.gets).toEqual([]);
    expect(keyFn).not.toHaveBeenCalled();
  });

  it("a cache() re-enabled under cache(false) stays in the enclosing partition", async () => {
    const scope = chain({ key: tierKey }, false, { ttl: 30 });

    expect(await recordKey(scope, { "x-tier": "gold" })).toBe(
      "key:tier%3Agold|doc%3Alocalhost%2Fpricing",
    );
  });

  it("each key() runs once per request: the shell partition, document and partial keys, a sibling scope and the capture share it", async () => {
    const outerFn = vi.fn(tierKey);
    const innerFn = vi.fn(variantKey);
    const outer = createCacheScope({ options: { key: outerFn } }, null, "C0")!;
    const scope = createCacheScope(
      { options: { key: innerFn } },
      outer,
      "C0C1",
    )!;
    const sibling = createCacheScope({ options: { ttl: 5 } }, outer, "C0C2")!;
    const store = recordingStore();
    const foreground = requestFor(
      { "x-tier": "gold", "x-variant": "a" },
      store,
    );

    await runWithRequestContext(foreground, async () => {
      await expect(
        resolveShellPartition(scope, null, "/pricing", {}),
      ).resolves.toBe("key:tier%3Agold|key:v%3Aa");
      await expect(
        scope.resolveKeyFrom("partial:localhost/pricing"),
      ).resolves.toBe("key:tier%3Agold|key:v%3Aa");
      await scope.lookupRoute("/pricing", {});
      await expect(
        sibling.resolveKeyFrom("doc:localhost/pricing"),
      ).resolves.toBe("key:tier%3Agold|doc%3Alocalhost%2Fpricing");
    });
    // shell-capture.ts derives the capture's context with Object.create.
    const capture = Object.create(foreground) as RequestContext;
    await runWithRequestContext(capture, async () => {
      await expect(scope.resolveKeyFrom("doc:localhost/pricing")).resolves.toBe(
        "key:tier%3Agold|key:v%3Aa",
      );
    });

    expect(store.gets).toEqual(["key:tier%3Agold|key:v%3Aa"]);
    expect(outerFn).toHaveBeenCalledTimes(1);
    expect(innerFn).toHaveBeenCalledTimes(1);
  });

  it("a ppr route's shell partition is the chain's key() results only: the shell key carries the URL", async () => {
    const store = recordingStore();

    await runWithRequestContext(
      requestFor({ "x-tier": "gold", "x-variant": "a" }, store),
      async () => {
        await expect(
          resolveShellPartition(
            chain({ key: tierKey }, { ttl: 30 }),
            store,
            "/pricing",
            {},
          ),
        ).resolves.toBe("key:tier%3Agold");
        await expect(
          resolveShellPartition(
            chain({ key: tierKey }, { ttl: 30 }, { key: variantKey }),
            store,
            "/pricing",
            {},
          ),
        ).resolves.toBe("key:tier%3Agold|key:v%3Aa");
      },
    );
  });

  it("an inner default key is its store keyGenerator result, and the shell partition keeps what the keyGenerator adds; a key() of its own skips the keyGenerator", async () => {
    const keyGenerator = vi.fn(
      (_ctx: RequestContext, defaultKey: string) => `${defaultKey}|gen`,
    );
    const store = recordingStore({ keyGenerator });
    const inherit = chain({ key: tierKey }, { ttl: 30 });

    await runWithRequestContext(
      requestFor({ "x-tier": "gold" }, store),
      async () => {
        await inherit.lookupRoute("/pricing", {});
        await expect(
          resolveShellPartition(inherit, store, "/pricing", {}),
        ).resolves.toBe("key:tier%3Agold|doc%3Alocalhost%2Fpricing%7Cgen");
      },
    );
    expect(store.gets).toEqual([
      "key:tier%3Agold|doc%3Alocalhost%2Fpricing%7Cgen",
    ]);
    // The record and the partition share one keyGenerator run.
    expect(keyGenerator).toHaveBeenCalledTimes(1);

    keyGenerator.mockClear();
    await runWithRequestContext(
      requestFor({ "x-tier": "gold", "x-variant": "a" }, store),
      () =>
        chain({ key: tierKey }, { key: variantKey }).lookupRoute(
          "/pricing",
          {},
        ),
    );
    expect(store.gets[1]).toBe("key:tier%3Agold|key:v%3Aa");
    expect(keyGenerator).not.toHaveBeenCalled();
  });

  it("a keyGenerator that returns the default key adds nothing to the shell partition", async () => {
    const store = recordingStore({
      keyGenerator: (_ctx: RequestContext, defaultKey: string) => defaultKey,
    });

    await runWithRequestContext(requestFor({ "x-tier": "gold" }, store), () =>
      expect(
        resolveShellPartition(
          chain({ key: tierKey }, { ttl: 30 }),
          store,
          "/pricing",
          {},
        ),
      ).resolves.toBe("key:tier%3Agold"),
    );
  });

  it("a throwing enclosing key() fails the inner lookup (error, no store read), never a shared key", async () => {
    const scope = chain(
      {
        key: () => {
          throw new Error("tier unavailable");
        },
      },
      { key: variantKey },
    );
    const store = recordingStore();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await runWithRequestContext(
      requestFor({ "x-variant": "a" }, store),
      () => scope.lookupRouteDetailed("/pricing", {}),
    );

    expect(outcome).toEqual({ status: "error" });
    expect(store.gets).toEqual([]);
    error.mockRestore();
  });
});
