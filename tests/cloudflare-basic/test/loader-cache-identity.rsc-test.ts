// Dogfood (#972): the app's own loader that reads cookies()
// (src/loaders/loader-cache-identity.ts) through runLoader's `cache` option,
// the read-through a route's `loader(Def, () => [cache({...})])` takes. The
// entry is keyed by loader, host, path and params: without a key() the read
// throws, with a key() that includes the cookie each session gets its own
// entry.
import { describe, expect, it, vi } from "vitest";
import { runLoader } from "@rangojs/router/testing";
import { cookies } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { CachedSessionLoader } from "../src/loaders/loader-cache-identity.js";

function asUser(session: string): Request {
  return new Request("http://localhost/loader-cache-identity/keyed", {
    headers: { cookie: `lci-session=${session}` },
  });
}

describe("CachedSessionLoader through its own cache()", () => {
  it("throws without a key(): the entry would be shared across users", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(cacheStore, "setItem");

    await expect(
      runLoader(CachedSessionLoader, {
        request: asUser("a"),
        cacheStore,
        cache: { ttl: 600 },
      }),
    ).rejects.toThrow(
      /cookies\(\) cannot be called inside loader .*no key\(\)/,
    );
    expect(setItem).not.toHaveBeenCalled();
  });

  it("with a key() that includes the cookie, each user gets their own entry", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(cacheStore, "setItem");
    const load = (session: string) =>
      runLoader(CachedSessionLoader, {
        request: asUser(session),
        cacheStore,
        cache: {
          ttl: 600,
          key: () => `lci-session:${cookies().get("lci-session")?.value}`,
        },
      });

    const a = await load("a");
    await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(1));
    const b = await load("b");
    await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(2));
    await Promise.all(setItem.mock.results.map((result) => result.value));

    expect(a.session).toBe("a");
    expect(b.session).toBe("b");
    // A HIT for user a: the stored stamp, not user b's.
    expect(await load("a")).toEqual(a);
  });
});
